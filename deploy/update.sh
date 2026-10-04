#!/usr/bin/env bash
# Update dish on its VM: fetch, move the checkout to the target, run install.sh, install the unit, restart dsh web when
# what it runs is stale, wait until it answers, and record what it started with.
#
#   deploy/update.sh [--apply] [<ref>]
#     (no flags)   a dry run toward origin/main: fetch, report what --apply would do, and change nothing else
#     --apply      fast-forward main to origin/main (switching back to main after a rollback), then install and restart
#     <ref>        a commit or tag; with --apply, it is checked out detached (a rollback)
#     -h, --help   usage
#
# Who runs it. You do, by hand, as root through fleet's wrapper: `incus exec dish --project dish -- dish-update`.
# - It runs only as the account: the owner of the checkout this script sits in (`dish` on the VM). Its uid and home
#   come from `getent passwd`. A checkout owned by root is refused.
# - Never as root: this file is the account's to write, so root running it would run whatever the account (or an agent
#   acting as it) put here. Root's entry point is /usr/local/sbin/dish-update, a root-owned wrapper fleet installs,
#   which runs this script as the account through runuser with a minimal environment and does nothing else. Run as
#   root, or as anyone but the account, it refuses with exit 2.
# - It runs itself again with a clean environment (env -i): HOME, USER, LOGNAME, XDG_RUNTIME_DIR=/run/user/<uid>, the
#   PATH of the checkout's unit, TMPDIR=~/.cache/dish/tmp, LANG and update.sh's own DISH_UPDATE_* names, and nothing
#   else. TMPDIR is not /tmp: a sandboxed command can write the machine's /tmp (deploy/dish-sandbox), and install.sh
#   keeps pnpm's and git's config in its throwaway directory there while it runs them outside the sandbox. No XDG_*
#   directories, PNPM_HOME, DSH_* or NODE_ENV, as for the unit, so the store `pnpm store path` gives install.sh is the
#   store the unit's plugin manager works out again (the store-pin contract, in install.sh and the unit).
# - PATH: update.sh's own commands (git, curl, systemctl) use the PATH it starts with, the checkout's unit's as it is
#   before the update. install.sh and the node and pnpm version checks get the PATH of the target's unit, the one that
#   will run, read from git before anything changes.
#
# Inputs:
# - ~/.config/dish/install.env, written by fleet, and never loaded by the unit: exactly DISH_REMOTE, DISH_USER_NAME and
#   DISH_USER_EMAIL, one NAME=value line each, the value verbatim. Blank lines and lines starting with # are ignored. All
#   three must be non-empty. An empty remote is refused: prod always pushes its store, and install.sh would remove it.
# - ~/.config/dish/deploy.env, the unit's: exactly one DISH_TRUSTED_HOST=<host> line, a bare host[:port].
# - The checkout's deploy/dish-web.service.
# DISH_UPDATE_WAIT sets how many seconds to wait for dsh (default 120); the tests use it.
#
# Steps, as the account:
#   1. take the lock (~/.local/state/dish/deploy/lock): one update at a time;
#   2. read the inputs;
#   3. fetch origin;
#   4. resolve the target: the ref given, else origin/main;
#   5. report: HEAD and the target, the commits between them, whether the unit, deploy.env and install.env differ from
#      what the service last started with, and whether it would restart;
#   6. check the checkout: no local changes, no commits on a detached HEAD that no branch or tag has (moving would lose
#      them), and with no ref, main (or detached) and able to fast-forward.
#      The dry run stops here. Everything above changes nothing but the fetched refs (and makes the lock file), so every
#      refusal comes before the first change, and a dry run that passes means --apply can start;
#   7. move the checkout: a fast-forward of main, or a detached checkout of the ref;
#   8. run install.sh, with DISH_SANDBOX_HOME=on, whose last line says whether it changed the profile;
#   9. install the unit when it differs, daemon-reload when the unit file or the unit the service last started with
#      differs from the checkout's, or the user manager says it needs one; make ~/work; enable the unit;
#  10. restart when the service isn't active, install.sh changed the profile, or the stamp is missing or differs;
#  11. wait until 127.0.0.1:3080 answers. If it doesn't and this run didn't restart, restart once and wait again;
#  12. after a restart, write the stamp: ~/.local/state/dish/deploy/started, six lines (revision, unit, deploy.env,
#      install.env, node, pnpm) describing what the service started with. It is written only once dsh answers, so a run
#      that fails after a restart restarts again next time.
# A failure stops the script and names the step on stderr, as `update: FAILED at step: <step> (exit N)`. After the
# checkout has moved, it also says where the checkout is and whether the service was restarted.
#
# Exit: 0 done or nothing to do; 1 a failed step; 2 usage, or not run as the account.
#
# Nothing it prints mentions a token: the journal tail, the commit list and install.sh's output (both streams, passed
# through on stdout) leave out every line that does, in any letter case, since dsh's sign-in line carries its access
# token. dish-url prints the sign-in link.
#
# It updates the file it runs from, so everything is in functions and the last line calls main: bash has read the
# whole script before git can change it.

set -euo pipefail
# A shell trace in the environment (SHELLOPTS, BASH_ENV) or from `bash -x` would print the journal's lines, and so the
# access token in dsh's sign-in line, to stderr.
set +o xtrace
shopt -s inherit_errexit lastpipe

readonly UNIT=dish-web.service
readonly LISTEN=127.0.0.1:3080

step=''
temporary=()
args=()
apply=0
ref=''
wait_seconds=120
self='' checkout='' account='' uid='' home=''
clean=()
state_dir='' install_env='' deploy_env=''
remote='' user_name='' user_email=''
head='' branch='' target='' target_name='' target_path='' target_unit=''
node_version='' pnpm_version=''
active_state=''
have_stamp=0
declare -A last_stamp=()
stamp=()
reasons=()
profile_changed=0
moved=0
old_head=''
restarted=0
answered=0

say() { printf 'update: %s\n' "$*"; }
warn() { printf 'update: %s\n' "$*" >&2; }

# Name the step that is starting, and say so.
begin() {
  step=$1
  say "$1"
}

fail() {
  warn "$1"
  exit 1
}

usage() {
  cat <<'EOF'
usage: deploy/update.sh [--apply] [<ref>]
  (no flags)   dry run toward origin/main: fetch, then show what --apply would do
  --apply      fast-forward main to origin/main, install, and restart dsh web when it is stale
  <ref>        a commit or tag; with --apply, checked out detached (a rollback)
  -h, --help   this help
As root, run dish-update instead (incus exec dish --project dish -- dish-update [--apply] [<ref>]): it runs this script
as the account that owns the checkout, which is the only account it runs as.
Exit: 0 done or nothing to do; 1 a failed step; 2 usage, or not run as the account.
EOF
}

usage_error() {
  step=''
  warn "$1"
  usage >&2
  exit 2
}

# Run by the EXIT trap. shellcheck reports a function it only reaches through a trap as SC2317 in 0.10 (the VM's)
# and as SC2329 in 0.11.
# shellcheck disable=SC2317,SC2329
on_exit() {
  local status=$? now service
  if [ "${#temporary[@]}" -gt 0 ]; then rm -f -- "${temporary[@]}"; fi
  if [ "$status" -ne 0 ] && [ -n "$step" ]; then
    warn "FAILED at step: $step (exit $status)"
    # Once the checkout has moved, say where things stand and how to go on.
    if [ "$moved" -eq 1 ]; then
      now=$(git -C "$checkout" rev-parse --verify HEAD 2>/dev/null) || now='(unknown)'
      service="$UNIT was not restarted"
      if [ "$restarted" -eq 1 ]; then service="$UNIT was restarted"; fi
      if [ "$now" = "$old_head" ]; then
        warn "the checkout is still at $now; $service; fix the problem and rerun dish-update --apply${ref:+ $ref}"
      else
        warn "the checkout is at $now (was $old_head); $service; fix the problem and rerun dish-update --apply${ref:+ $ref}, or go back with dish-update --apply $old_head"
      fi
    fi
    # A failed step exits 1, whatever the failed command returned (install.sh can exit 2, which here means usage). A
    # signal keeps its code.
    case $status in
      130 | 143) ;;
      *) exit 1 ;;
    esac
  fi
}

# Print stdin's lines indented, at most <max> of them (0: all), leaving out every line that mentions a token.
show_lines() {
  local max=${1:-0} line shown=0 more=0 hidden=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ ${line,,} == *token* ]]; then
      hidden=$((hidden + 1))
    elif [ "$max" -gt 0 ] && [ "$shown" -ge "$max" ]; then
      more=$((more + 1))
    else
      printf '  %s\n' "$line"
      shown=$((shown + 1))
    fi
  done
  if [ "$more" -gt 0 ]; then printf '  (and %d more)\n' "$more"; fi
  if [ "$hidden" -gt 0 ]; then printf '  (%s left out)\n' "$(plural "$hidden" line lines)"; fi
}

# "1 commit", "2 commits".
plural() {
  if [ "$1" -eq 1 ]; then printf '1 %s' "$2"; else printf '%d %s' "$1" "$3"; fi
}

sha256() {
  local out
  out=$(sha256sum "$@")
  printf '%s\n' "${out%% *}"
}

# The value of the one Environment=PATH= line of the unit on stdin. <label> names the unit in the message.
unit_path() {
  local label=$1 line value='' count=0
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      Environment=PATH=*)
        value=${line#Environment=PATH=}
        count=$((count + 1))
        ;;
    esac
  done
  if [ "$count" -ne 1 ] || [ -z "$value" ]; then
    warn "$label needs exactly one Environment=PATH= line, with a value"
    return 1
  fi
  printf '%s\n' "$value"
}

# The service's last 15 journal lines, read as the account, without the lines that mention a token.
print_the_journal() {
  local lines
  if lines=$(journalctl --user -u "$UNIT" -n 15 -q --no-pager -o short-iso 2>/dev/null 9>&-) && [ -n "$lines" ]; then
    say 'journal (last 15 lines, credential lines removed):'
    printf '%s\n' "$lines" | show_lines
  else
    say "journal: nothing readable as $account (journalctl --user -u $UNIT)"
  fi
}

parse_arguments() {
  local arg have_ref=0
  for arg in "$@"; do
    case $arg in
      --apply) apply=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*) usage_error "unknown option: $arg (a ref can't start with -)" ;;
      '') usage_error 'an empty ref' ;;
      *)
        if [ "$have_ref" -eq 1 ]; then usage_error "one ref at most, not $ref and $arg"; fi
        ref=$arg
        have_ref=1
        ;;
    esac
  done
  if [ -n "${DISH_UPDATE_WAIT+x}" ]; then
    if ! [[ $DISH_UPDATE_WAIT =~ ^[0-9]{1,5}$ ]]; then usage_error 'DISH_UPDATE_WAIT must be a whole number of seconds'; fi
    wait_seconds=$((10#$DISH_UPDATE_WAIT))
  fi
}

# The checkout is this script's ../, and the account is its owner.
find_the_checkout() {
  step='finding the checkout'
  self=$(readlink -f -- "${BASH_SOURCE[0]}")
  checkout=$(dirname -- "$(dirname -- "$self")")
  account=$(stat -c %U -- "$checkout")
  if [ "$account" = root ]; then fail "$checkout is owned by root; update.sh runs as the account that owns the checkout"; fi
}

find_the_account() {
  step='finding the account'
  local entry
  entry=$(getent passwd "$account") || fail "getent passwd has no $account, the owner of $checkout"
  IFS=: read -r _ _ uid _ _ home _ <<<"$entry"
  if ! [[ $uid =~ ^[0-9]+$ ]] || [[ $home != /* ]]; then fail "getent passwd $account gave no uid and home"; fi
}

# Root, or anyone but the account.
refuse_the_caller() {
  step=''
  warn "run dish-update as root (incus exec dish --project dish -- dish-update [--apply] [<ref>]), or this script as $account"
  exit 2
}

# As the account, from the wrapper, a login or a shell: run again with the clean environment. PATH is the unit's, read
# from the checkout as it is now.
run_clean() {
  step="reading PATH from $checkout/deploy/$UNIT"
  local path
  path=$(unit_path "the checkout's deploy/$UNIT" <"$checkout/deploy/$UNIT")
  # dsh's own temp directory (the unit's TMPDIR), which dish-sandbox protects: not /tmp, which sandboxed commands write.
  step="making $home/.cache/dish/tmp"
  (umask 077 && mkdir -p -- "$home/.cache/dish/tmp")
  clean=(
    "HOME=$home" "USER=$account" "LOGNAME=$account" "XDG_RUNTIME_DIR=/run/user/$uid" "PATH=$path"
    "TMPDIR=$home/.cache/dish/tmp" LANG=C.UTF-8 DISH_UPDATE_CLEAN=1
  )
  if [ -n "${DISH_UPDATE_WAIT+x}" ]; then clean+=("DISH_UPDATE_WAIT=$DISH_UPDATE_WAIT"); fi
  step="moving to $home"
  cd -- "$home"
  step='running update.sh again in a clean environment'
  exec env -i "${clean[@]}" "$BASH" "$self" "${args[@]}"
}

# DISH_UPDATE_CLEAN is update.sh's own. Set by hand, it must not let the caller's environment reach install.sh, so the
# environment must hold the clean names and nothing else (bash adds PWD, OLDPWD, SHLVL and _ itself).
check_the_environment() {
  step='checking the environment'
  local name hidden=0
  local -a names extra=()
  mapfile -t names < <(compgen -e)
  for name in "${names[@]}"; do
    case $name in
      HOME | USER | LOGNAME | XDG_RUNTIME_DIR | PATH | TMPDIR | LANG | DISH_UPDATE_CLEAN | DISH_UPDATE_WAIT) ;;
      PWD | OLDPWD | SHLVL | _) ;;
      *)
        if [[ ${name,,} == *token* ]]; then hidden=$((hidden + 1)); else extra+=("$name"); fi
        ;;
    esac
  done
  if [ $((${#extra[@]} + hidden)) -gt 0 ]; then
    if [ "$hidden" -gt 0 ]; then extra+=("and $(plural "$hidden" other other)"); fi
    fail "the environment has names besides update.sh's clean ones (${extra[*]}); DISH_UPDATE_CLEAN is update.sh's own, so run update.sh without it"
  fi
  step='checking the tools on PATH'
  local tool
  for tool in git flock curl systemctl sha256sum mktemp; do
    command -v "$tool" >/dev/null || fail "$tool is not on PATH ($PATH)"
  done
}

take_the_lock() {
  step='taking the lock'
  state_dir=$home/.local/state/dish/deploy
  mkdir -p -- "$state_dir"
  exec 9>>"$state_dir/lock"
  flock -n 9 || fail "another update is running: $state_dir/lock is held"
}

read_the_inputs() {
  step='reading the inputs'
  install_env=$home/.config/dish/install.env
  deploy_env=$home/.config/dish/deploy.env
  if [ ! -f "$install_env" ]; then fail "$install_env is missing; fleet writes it"; fi

  local line number=0 name value seen=' '
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    case $line in '' | '#'*) continue ;; esac
    if [[ $line != *=* ]]; then fail "$install_env line $number is not NAME=value"; fi
    name=${line%%=*}
    value=${line#*=}
    case $name in
      DISH_REMOTE | DISH_USER_NAME | DISH_USER_EMAIL) ;;
      *) fail "$install_env line $number: only DISH_REMOTE, DISH_USER_NAME and DISH_USER_EMAIL belong there" ;;
    esac
    if [[ $seen == *" $name "* ]]; then fail "$install_env has $name more than once"; fi
    seen+="$name "
    if [ -z "$value" ] && [ "$name" = DISH_REMOTE ]; then
      fail "DISH_REMOTE is empty in $install_env: prod always pushes its store, and install.sh would remove the remote"
    fi
    if [ -z "$value" ]; then fail "$name is empty in $install_env"; fi
    if [[ $value == *[[:cntrl:]]* ]]; then fail "$name in $install_env has a control character"; fi
    case $name in
      DISH_REMOTE) remote=$value ;;
      DISH_USER_NAME) user_name=$value ;;
      DISH_USER_EMAIL) user_email=$value ;;
    esac
  done <"$install_env"
  for name in DISH_REMOTE DISH_USER_NAME DISH_USER_EMAIL; do
    if [[ $seen != *" $name "* ]]; then fail "$install_env has no $name line"; fi
  done

  # The unit can't start without its trusted host, so an update would stop at the wait. The rule is url.sh's.
  if [ ! -f "$deploy_env" ]; then fail "$deploy_env is missing; fleet writes it"; fi
  local host='' hosts=0 host_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$'
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line == DISH_TRUSTED_HOST=* ]]; then
      host=${line#DISH_TRUSTED_HOST=}
      hosts=$((hosts + 1))
    fi
  done <"$deploy_env"
  if [ "$hosts" -ne 1 ] || [[ ! $host =~ $host_re ]]; then
    fail "$deploy_env needs exactly one DISH_TRUSTED_HOST=<host> line with a bare host name (no scheme or path); fleet writes it"
  fi
}

find_the_target() {
  step='finding the target'
  if [ -n "$ref" ]; then
    target=$(git -C "$checkout" rev-parse --verify --quiet --end-of-options "$ref^{commit}") || fail "unknown ref: $ref"
    target_name=$ref
  else
    target=$(git -C "$checkout" rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}') || fail 'origin has no main branch'
    target_name=origin/main
  fi
  head=$(git -C "$checkout" rev-parse --verify HEAD)
  branch=$(git -C "$checkout" symbolic-ref --quiet --short HEAD) || branch=''
}

# The first line of `<tool> --version`, found on the target unit's PATH.
version() {
  local out
  out=$(env "PATH=$target_path" "$1" --version </dev/null)
  out=${out%%$'\n'*}
  if [ -z "$out" ]; then
    warn "$1 --version printed nothing"
    return 1
  fi
  printf '%s\n' "$out"
}

read_the_stamp() {
  local line
  last_stamp=()
  have_stamp=0
  if [ ! -f "$state_dir/started" ]; then return 0; fi
  have_stamp=1
  while IFS= read -r line || [ -n "$line" ]; do
    case ${line%% *} in
      revision | unit | deploy.env | install.env | node | pnpm) last_stamp[${line%% *}]=${line#* } ;;
    esac
  done <"$state_dir/started"
}

# The service's state, from the account's user manager. A manager that doesn't answer stops the update: systemctl
# prints nothing then, where an unknown or stopped unit is "inactive".
read_the_service() {
  active_state=$(systemctl --user is-active "$UNIT" 2>/dev/null) || true
  if [ -z "$active_state" ]; then
    fail "can't reach $account's user manager (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR-}; is linger on?)"
  fi
}

# The stamp a start of <revision>, with the unit whose sha256 is <unit sum>, would get. Sets `stamp`.
make_stamp() {
  local deploy_sum install_sum
  deploy_sum=$(sha256 "$deploy_env")
  install_sum=$(sha256 "$install_env")
  stamp=("revision $1" "unit $2" "deploy.env $deploy_sum" "install.env $install_sum" "node $node_version" "pnpm $pnpm_version")
}

# Why the service, started with what `stamp` says, would need a restart. Sets `reasons`.
stale_reasons() {
  local line key
  reasons=()
  read_the_service
  if [ "$active_state" != active ]; then reasons+=("not active ($active_state)"); fi
  if [ "$have_stamp" -eq 0 ]; then
    reasons+=('no record of a start')
    return 0
  fi
  for line in "${stamp[@]}"; do
    key=${line%% *}
    if [ "${last_stamp[$key]-}" != "${line#* }" ]; then reasons+=("$key changed"); fi
  done
}

joined_reasons() {
  local joined
  printf -v joined '%s, ' "${reasons[@]}"
  printf '%s\n' "${joined%, }"
}

# What an input file is, compared with the last start.
input_state() {
  local name=$1 file=$2 sum
  sum=$(sha256 "$file")
  if [ "$have_stamp" -eq 0 ]; then
    printf 'no record of a start\n'
  elif [ "${last_stamp[$name]-}" = "$sum" ]; then
    printf 'same as the last start\n'
  else
    printf 'changed since the last start\n'
  fi
}

report_the_commits() {
  local count only_head only_target
  if [ "$head" = "$target" ]; then
    say 'already at the target'
  elif git -C "$checkout" merge-base --is-ancestor "$head" "$target"; then
    count=$(git -C "$checkout" rev-list --count "$head..$target")
    say "$(plural "$count" commit commits) to apply"
    git -C "$checkout" log --no-color --format='%h %s' "$head..$target" | show_lines
  elif git -C "$checkout" merge-base --is-ancestor "$target" "$head"; then
    count=$(git -C "$checkout" rev-list --count "$target..$head")
    say "$(plural "$count" commit commits) to roll back"
    git -C "$checkout" log --no-color --format='%h %s' "$target..$head" | show_lines
  else
    only_head=$(git -C "$checkout" rev-list --count "$target..$head")
    only_target=$(git -C "$checkout" rev-list --count "$head..$target")
    say "diverged: $(plural "$only_head" commit commits) only at HEAD, $only_target only at the target"
    git -C "$checkout" log --no-color --left-right --format='%m %h %s' "$head...$target" | show_lines
  fi
}

# What the target would bring, and whether the service would restart for it. It changes nothing.
report() {
  step='reading the target'
  # An --apply that moved the checkout to a target without these would stop halfway, or leave a checkout that
  # dish-update can't run in (a rollback to before update.sh existed), so they are checked first.
  local file
  for file in deploy/update.sh deploy/install.sh "deploy/$UNIT"; do
    if ! git -C "$checkout" cat-file -e "$target:$file" 2>/dev/null; then
      fail "$target_name has no $file, so the checkout can't move there; dish-update needs it there to run again"
    fi
  done
  target_path=$(git -C "$checkout" cat-file blob "$target:deploy/$UNIT" | unit_path "$target_name:deploy/$UNIT")
  target_unit=$(git -C "$checkout" cat-file blob "$target:deploy/$UNIT" | sha256)
  step='reading the node and pnpm versions'
  node_version=$(version node)
  pnpm_version=$(version pnpm)
  step='reading the stamp'
  read_the_stamp
  step="asking $account's user manager about $UNIT"
  make_stamp "$target" "$target_unit"
  stale_reasons

  step='reporting'
  local installed=$home/.config/systemd/user/$UNIT unit_line installed_sum deploy_line install_line
  if [ ! -f "$installed" ]; then
    unit_line='not installed'
  else
    installed_sum=$(sha256 "$installed")
    if [ "$installed_sum" = "$target_unit" ]; then unit_line=same; else unit_line=changes; fi
  fi
  deploy_line=$(input_state deploy.env "$deploy_env")
  install_line=$(input_state install.env "$install_env")

  say "HEAD $head (${branch:-detached})"
  say "target $target ($target_name)"
  report_the_commits
  say "unit: $unit_line"
  say "deploy.env: $deploy_line"
  say "install.env: $install_line"
  if [ "${#reasons[@]}" -gt 0 ]; then say "restart: needed ($(joined_reasons))"; else say 'restart: not needed'; fi
}

# Refusals that need the checkout. Ignored files, such as node_modules and .dev/, don't count as local changes.
check_the_checkout() {
  step='checking the checkout'
  local changes stray
  changes=$(git --no-optional-locks -C "$checkout" status --porcelain --untracked-files=normal)
  if [ -n "$changes" ]; then
    warn "the checkout has local changes, which update.sh leaves alone:"
    printf '%s\n' "$changes" | show_lines 10 >&2
    exit 1
  fi
  # A detached HEAD (after a rollback) may have commits of its own, made there: moving the checkout, back to main or to
  # another ref, would leave them on no branch.
  if [ -z "$branch" ]; then
    stray=$(git -C "$checkout" rev-list -n 1 HEAD --not --remotes --tags --branches)
    if [ -n "$stray" ]; then fail 'HEAD has commits no branch or tag has; update.sh would leave them behind'; fi
  fi
  if [ -n "$ref" ]; then return 0; fi
  if [ -n "$branch" ] && [ "$branch" != main ]; then
    fail "the checkout is on branch $branch; update.sh updates main, or checks out a ref you give it"
  fi
  git -C "$checkout" rev-parse --verify --quiet refs/heads/main >/dev/null || fail 'the checkout has no main branch'
  git -C "$checkout" merge-base --is-ancestor refs/heads/main "$target" ||
    fail "main has commits that origin/main doesn't, so it can't fast-forward; update.sh never resets it"
}

# The first change. The lock's descriptor is closed for git, whose gc or maintenance can outlive it.
move_the_checkout() {
  local now
  old_head=$head
  moved=1
  if [ -n "$ref" ]; then
    begin "checking out $target detached"
    git -C "$checkout" switch --quiet --detach "$target" 9>&-
  else
    if [ -z "$branch" ]; then
      begin 'switching back to main'
      git -C "$checkout" switch --quiet main 9>&-
    fi
    now=$(git -C "$checkout" rev-parse --verify HEAD)
    if [ "$now" != "$target" ]; then
      begin 'fast-forwarding main to origin/main'
      git -C "$checkout" merge --quiet --ff-only "$target" 9>&-
    fi
  fi
  head=$(git -C "$checkout" rev-parse --verify HEAD)
  if [ "$head" != "$target" ]; then fail "HEAD is $head, not the target"; fi
}

# install.sh, with the unit's environment, install.env's inputs and DISH_SANDBOX_HOME=on: on the VM, agents' sandboxed
# commands can write the home directory less a protected list (deploy/dish-sandbox). Its output, both streams, passes
# through on stdout, less the lines that mention a token; its last line says whether it changed the profile.
run_install() {
  begin 'running deploy/install.sh'
  local line last='' hidden=0
  env -u DISH_UPDATE_CLEAN -u DISH_UPDATE_WAIT "PATH=$target_path" \
    "DISH_REMOTE=$remote" "DISH_USER_NAME=$user_name" "DISH_USER_EMAIL=$user_email" DISH_SANDBOX_HOME=on \
    "$checkout/deploy/install.sh" </dev/null 9>&- 2>&1 |
    while IFS= read -r line || [ -n "$line" ]; do
      last=$line
      if [[ ${line,,} == *token* ]]; then hidden=$((hidden + 1)); else printf '%s\n' "$line"; fi
    done
  if [ "$hidden" -gt 0 ]; then say "left out $(plural "$hidden" line lines) of install.sh's output"; fi
  case $last in
    'install: profile changed') profile_changed=1 ;;
    'install: no changes to the profile') profile_changed=0 ;;
    *) fail 'deploy/install.sh did not end with its summary line (install: profile changed, or install: no changes to the profile)' ;;
  esac
}

# Copy the unit when it differs, and daemon-reload whenever the user manager may hold another definition: the file
# changed, the service last started with another unit (or there is no record of a start), or the manager says so. A
# reload that failed or was cut short is so done again by the next run, before any restart.
install_the_unit() {
  step='comparing the installed unit'
  local dir=$home/.config/systemd/user tmp source_sum installed_sum='' pending enabled reload=0
  source_sum=$(sha256 "$checkout/deploy/$UNIT")
  if [ -f "$dir/$UNIT" ]; then installed_sum=$(sha256 "$dir/$UNIT"); fi
  if [ "$source_sum" != "$installed_sum" ]; then
    begin "installing $UNIT in $dir"
    mkdir -p -- "$dir"
    tmp=$(mktemp -- "$dir/.$UNIT.XXXXXX")
    temporary+=("$tmp")
    cp -- "$checkout/deploy/$UNIT" "$tmp"
    chmod 0644 -- "$tmp"
    mv -f -- "$tmp" "$dir/$UNIT"
    reload=1
  fi
  if [ "$have_stamp" -eq 0 ] || [ "${last_stamp[unit]-}" != "$source_sum" ]; then reload=1; fi
  step='asking whether the user manager needs a reload'
  pending=$(systemctl --user show -p NeedDaemonReload --value "$UNIT" 2>/dev/null) || pending=''
  if [ "$pending" = yes ]; then reload=1; fi
  if [ "$reload" -eq 1 ]; then
    begin 'reloading the user manager'
    systemctl --user daemon-reload
  fi

  step="making $home/work"
  if [ ! -d "$home/work" ]; then mkdir -m 0700 -- "$home/work"; fi

  step="checking that $UNIT is enabled"
  enabled=$(systemctl --user is-enabled "$UNIT" 2>/dev/null) || true
  if [ "$enabled" != enabled ]; then
    begin "enabling $UNIT"
    systemctl --user enable --quiet "$UNIT"
  fi
}

# Restart for the reasons in `reasons`, and say them.
restart_now() {
  say "restart: needed ($(joined_reasons))"
  begin "restarting $UNIT"
  systemctl --user restart "$UNIT"
  restarted=1
}

restart_when_stale() {
  step='deciding whether to restart'
  local unit_sum
  unit_sum=$(sha256 "$checkout/deploy/$UNIT")
  make_stamp "$head" "$unit_sum"
  stale_reasons
  if [ "$profile_changed" -eq 1 ]; then reasons+=('install.sh changed the profile'); fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    say 'restart: not needed'
    return 0
  fi
  restart_now
}

# Poll until dsh answers or the wait runs out. Sets `answered`. Any HTTP answer, even a 401 for the missing sign-in,
# means dsh is up.
wait_for_dsh() {
  begin "waiting for dsh on $LISTEN"
  local deadline=$((SECONDS + wait_seconds)) code
  answered=0
  while :; do
    code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$LISTEN/" 9>&-) || true
    if [ -n "$code" ] && [ "$code" != 000 ]; then
      answered=1
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then return 0; fi
    sleep 2
  done
}

write_the_stamp() {
  step='writing the stamp'
  local tmp
  tmp=$(mktemp -- "$state_dir/.started.XXXXXX")
  temporary+=("$tmp")
  printf '%s\n' "${stamp[@]}" >"$tmp"
  mv -f -- "$tmp" "$state_dir/started"
}

print_the_result() {
  step='printing the result'
  local how=unchanged
  if [ "$restarted" -eq 1 ]; then how=restarted; fi
  active_state=$(systemctl --user is-active "$UNIT" 2>/dev/null) || true
  say "HEAD $head"
  say "$UNIT: ${active_state:-unknown} ($how)"
  if [ "$restarted" -eq 1 ]; then say 'run dish-url for a fresh sign-in link (incus exec dish --project dish -- dish-url)'; fi
  print_the_journal
  step=''
}

# The work, as the account, in the clean environment.
update() {
  cd -- "$home"
  check_the_environment
  take_the_lock
  read_the_inputs
  step='fetching origin'
  GIT_TERMINAL_PROMPT=0 git -C "$checkout" fetch --quiet --prune origin 9>&-
  find_the_target
  report
  check_the_checkout
  if [ "$apply" -eq 0 ]; then
    step=''
    say 'dry run; run with --apply to update'
    return 0
  fi

  move_the_checkout
  run_install
  install_the_unit
  restart_when_stale
  wait_for_dsh
  # A service that runs but doesn't answer, and that this run didn't restart, gets one restart.
  if [ "$answered" -eq 0 ] && [ "$restarted" -eq 0 ]; then
    reasons=("did not answer on $LISTEN within $wait_seconds seconds")
    restart_now
    wait_for_dsh
  fi
  if [ "$answered" -eq 0 ]; then
    print_the_journal
    fail "dsh did not answer on $LISTEN within $wait_seconds seconds"
  fi
  if [ "$restarted" -eq 1 ]; then write_the_stamp; fi
  print_the_result
}

main() {
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  args=("$@")
  parse_arguments "$@"
  find_the_checkout

  step='checking who runs update.sh'
  local me
  me=$(id -u)
  if [ "$me" = 0 ]; then refuse_the_caller; fi
  find_the_account
  if [ "$me" != "$uid" ]; then refuse_the_caller; fi
  if [ -z "${DISH_UPDATE_CLEAN+x}" ]; then run_clean; fi
  update
}

main "$@"; exit
