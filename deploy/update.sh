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
# Who runs it. You do, by hand: `incus exec dish --project dish -- /home/dish/dish/deploy/update.sh`.
# - The account is the owner of the checkout this script sits in (`dish` on the VM). Its uid and home come from
#   `getent passwd`. A checkout owned by root is refused.
# - As root, which is what incus exec gives, it runs itself again as the account (runuser), with a clean environment.
#   Then, after an --apply, it prints the service's journal, which root can read.
# - As the account, it runs itself again with the same clean environment (env -i).
# - Anyone else is refused.
#
# The clean environment is HOME, USER, LOGNAME, XDG_RUNTIME_DIR, the PATH of the checkout's unit, TMPDIR, LANG and
# update.sh's own DISH_UPDATE_* names. Nothing else: no XDG_* directories, PNPM_HOME, DSH_* or NODE_ENV, as for the
# unit. install.sh then runs with what the unit runs with, so the store `pnpm store path` gives it is the store the
# unit's plugin manager works out again (the store-pin contract, in install.sh and the unit). install.sh and the version
# checks get the PATH of the target's unit, the one that will run.
#
# Inputs:
# - ~/.config/dish/install.env, written by fleet, and never loaded by the unit: exactly DISH_REMOTE, DISH_USER_NAME and
#   DISH_USER_EMAIL, one NAME=value line each, the value verbatim. Blank lines and lines starting with # are ignored. All
#   three must be non-empty. An empty remote is refused: prod always pushes its store, and install.sh would remove it.
# - ~/.config/dish/deploy.env, the unit's, which must have its DISH_TRUSTED_HOST line.
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
#   6. check the checkout: no local changes, and with no ref, main (or detached) and able to fast-forward.
#      The dry run stops here. Everything above changes nothing but the fetched refs (and makes the lock file), so every
#      refusal comes before the first change, and a dry run that passes means --apply can start;
#   7. move the checkout: a fast-forward of main, or a detached checkout of the ref;
#   8. run install.sh, whose last line says whether it changed the profile;
#   9. install the unit when it differs (and daemon-reload), make ~/work, enable the unit;
#  10. restart when the service isn't active, install.sh changed the profile, or the stamp is missing or differs;
#  11. wait until 127.0.0.1:3080 answers;
#  12. after a restart, write the stamp: ~/.local/state/dish/deploy/started, six lines (revision, unit, deploy.env,
#      install.env, node, pnpm) describing what the service started with. It is written only once dsh answers, so a run
#      that fails after a restart restarts again next time.
# A failure stops the script and names the step on stderr, as `update: FAILED at step: <step> (exit N)`.
#
# Exit: 0 done or nothing to do; 1 a failed step; 2 usage or the wrong account.
#
# Nothing it prints mentions a token: the journal tail and the commit list leave out every line that does, in any letter
# case, since dsh's sign-in line carries its access token. deploy/url.sh prints the sign-in link. install.sh's own
# output passes through as it is; it never starts dsh web, so it has no access token to print.
#
# It updates the file it runs from, so everything is in functions and the last line calls main: bash has read the
# whole script before git can change it.

set -euo pipefail
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
have_stamp=0
declare -A last_stamp=()
stamp=()
reasons=()
profile_changed=0
restarted=0

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
Run it as root (incus exec gives root) or as the account that owns the checkout.
Exit: 0 done or nothing to do; 1 a failed step; 2 usage or the wrong account.
EOF
}

usage_error() {
  step=''
  warn "$1"
  usage >&2
  exit 2
}

# Run by the EXIT trap.
# shellcheck disable=SC2329
on_exit() {
  local status=$?
  if [ "${#temporary[@]}" -gt 0 ]; then rm -f -- "${temporary[@]}"; fi
  if [ "$status" -ne 0 ] && [ -n "$step" ]; then
    warn "FAILED at step: $step (exit $status)"
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
  if [ "$hidden" -eq 1 ]; then printf '  (1 line left out)\n'; fi
  if [ "$hidden" -gt 1 ]; then printf '  (%d lines left out)\n' "$hidden"; fi
}

# "1 commit", "2 commits".
commits() {
  if [ "$1" -eq 1 ]; then printf '1 commit'; else printf '%d commits' "$1"; fi
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

# The journal's tail, without the lines that mention a token: journalctl with the arguments after <unreadable>, which
# is what to say when it prints nothing.
print_journal() {
  local unreadable=$1 lines
  shift
  if lines=$(journalctl "$@" 2>/dev/null) && [ -n "$lines" ]; then
    say 'journal (last 15 lines, credential lines removed):'
    printf '%s\n' "$lines" | show_lines
  else
    say "$unreadable"
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
find_the_account() {
  step='finding the account'
  local entry
  self=$(readlink -f -- "${BASH_SOURCE[0]}")
  checkout=$(dirname -- "$(dirname -- "$self")")
  account=$(stat -c %U -- "$checkout")
  if [ "$account" = root ]; then fail "$checkout is owned by root; update.sh runs as the account that owns the checkout"; fi
  entry=$(getent passwd "$account") || fail "getent passwd has no $account, the owner of $checkout"
  IFS=: read -r _ _ uid _ _ home _ <<<"$entry"
  if ! [[ $uid =~ ^[0-9]+$ ]] || [[ $home != /* ]]; then fail "getent passwd $account gave no uid and home"; fi
}

# The environment the account's run gets, and nothing else. PATH is the unit's, read from the checkout as it is now.
clean_environment() {
  step="reading PATH from $checkout/deploy/$UNIT"
  local path
  path=$(unit_path "the checkout's deploy/$UNIT" <"$checkout/deploy/$UNIT")
  clean=(
    "HOME=$home" "USER=$account" "LOGNAME=$account" "XDG_RUNTIME_DIR=/run/user/$uid" "PATH=$path"
    TMPDIR=/tmp LANG=C.UTF-8 DISH_UPDATE_CLEAN=1
  )
  if [ -n "${DISH_UPDATE_WAIT+x}" ]; then clean+=("DISH_UPDATE_WAIT=$DISH_UPDATE_WAIT"); fi
}

# As root: run again as the account, then show the journal, which only root can read.
run_as_the_account() {
  clean_environment
  step="moving to $home"
  cd -- "$home"
  step="running update.sh as $account"
  local status=0
  runuser -u "$account" -- env -i "${clean[@]}" DISH_UPDATE_PARENT=root "$BASH" "$self" "${args[@]}" || status=$?
  # The run has named its own failure. Anything else (runuser's own) is a failed step here.
  case $status in
    0 | 1 | 2 | 130 | 143) step='' ;;
  esac
  if [ "$apply" -eq 1 ]; then
    print_journal 'journal: could not be read' "_UID=$uid" "_SYSTEMD_USER_UNIT=$UNIT" -n 15 --no-pager -o short-iso
  fi
  exit "$status"
}

# As the account, from a login or a shell: run again with the clean environment.
run_clean() {
  clean_environment
  step="moving to $home"
  cd -- "$home"
  step='running update.sh again in a clean environment'
  exec env -i "${clean[@]}" "$BASH" "$self" "${args[@]}"
}

# DISH_UPDATE_CLEAN is update.sh's own. Set by hand, it must not let the caller's environment reach install.sh.
refuse_a_borrowed_environment() {
  step='checking the environment'
  local name
  local -a names
  mapfile -t names < <(compgen -e)
  for name in "${names[@]}"; do
    case $name in
      XDG_RUNTIME_DIR) ;;
      XDG_* | PNPM_HOME | DSH_* | NODE_ENV | NODE_OPTIONS | npm_config_* | pnpm_config_*)
        fail "the environment has names install.sh must not get (XDG_*, PNPM_HOME, DSH_*, NODE_*, npm or pnpm config); DISH_UPDATE_CLEAN is update.sh's own, so run update.sh without it"
        ;;
    esac
  done
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

  # The unit can't start without its trusted host, so an update would stop at the wait.
  if [ ! -f "$deploy_env" ]; then fail "$deploy_env is missing; fleet writes it"; fi
  local host=''
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in DISH_TRUSTED_HOST=?*) host=${line#DISH_TRUSTED_HOST=} ;; esac
  done <"$deploy_env"
  if [ -z "$host" ]; then fail "$deploy_env has no DISH_TRUSTED_HOST=<host> line; fleet writes it"; fi
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

# The stamp a start of <revision>, with the unit whose sha256 is <unit sum>, would get. Sets `stamp`.
make_stamp() {
  local deploy_sum install_sum
  deploy_sum=$(sha256 "$deploy_env")
  install_sum=$(sha256 "$install_env")
  stamp=("revision $1" "unit $2" "deploy.env $deploy_sum" "install.env $install_sum" "node $node_version" "pnpm $pnpm_version")
}

# Why the service, started with what `stamp` says, would need a restart. Sets `reasons`.
stale_reasons() {
  local active line key
  reasons=()
  active=$(systemctl --user is-active "$UNIT" 2>/dev/null) || true
  if [ "$active" != active ]; then reasons+=("not active (${active:-unknown})"); fi
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
    say "$(commits "$count") to apply"
    git -C "$checkout" log --no-color --format='%h %s' "$head..$target" | show_lines
  elif git -C "$checkout" merge-base --is-ancestor "$target" "$head"; then
    count=$(git -C "$checkout" rev-list --count "$target..$head")
    say "$(commits "$count") to roll back"
    git -C "$checkout" log --no-color --format='%h %s' "$target..$head" | show_lines
  else
    only_head=$(git -C "$checkout" rev-list --count "$target..$head")
    only_target=$(git -C "$checkout" rev-list --count "$head..$target")
    say "diverged: $(commits "$only_head") only at HEAD, $only_target only at the target"
    git -C "$checkout" log --no-color --left-right --format='%m %h %s' "$head...$target" | show_lines
  fi
}

# What the target would bring, and whether the service would restart for it. It changes nothing.
report() {
  step='reading the target'
  # An --apply that moved the checkout to a target without these would stop halfway, so they are checked first.
  if ! git -C "$checkout" cat-file -e "$target:deploy/install.sh" 2>/dev/null; then fail "$target_name has no deploy/install.sh"; fi
  if ! git -C "$checkout" cat-file -e "$target:deploy/$UNIT" 2>/dev/null; then fail "$target_name has no deploy/$UNIT"; fi
  target_path=$(git -C "$checkout" cat-file blob "$target:deploy/$UNIT" | unit_path "$target_name:deploy/$UNIT")
  target_unit=$(git -C "$checkout" cat-file blob "$target:deploy/$UNIT" | sha256)
  step='reading the node and pnpm versions'
  node_version=$(version node)
  pnpm_version=$(version pnpm)
  step='reading the stamp'
  read_the_stamp

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
  make_stamp "$target" "$target_unit"
  stale_reasons

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
  local changes
  changes=$(git --no-optional-locks -C "$checkout" status --porcelain --untracked-files=normal)
  if [ -n "$changes" ]; then
    warn "the checkout has local changes, which update.sh leaves alone:"
    printf '%s\n' "$changes" | show_lines 10 >&2
    exit 1
  fi
  if [ -n "$ref" ]; then return 0; fi
  if [ -n "$branch" ] && [ "$branch" != main ]; then
    fail "the checkout is on branch $branch; update.sh updates main, or checks out a ref you give it"
  fi
  git -C "$checkout" rev-parse --verify --quiet refs/heads/main >/dev/null || fail 'the checkout has no main branch'
  git -C "$checkout" merge-base --is-ancestor refs/heads/main "$target" ||
    fail "main has commits that origin/main doesn't, so it can't fast-forward; update.sh never resets it"
}

move_the_checkout() {
  local now
  if [ -n "$ref" ]; then
    begin "checking out $target detached"
    git -C "$checkout" switch --quiet --detach "$target"
  else
    if [ -z "$branch" ]; then
      begin 'switching back to main'
      git -C "$checkout" switch --quiet main
    fi
    now=$(git -C "$checkout" rev-parse --verify HEAD)
    if [ "$now" != "$target" ]; then
      begin 'fast-forwarding main to origin/main'
      git -C "$checkout" merge --quiet --ff-only "$target"
    fi
  fi
  head=$(git -C "$checkout" rev-parse --verify HEAD)
  if [ "$head" != "$target" ]; then fail "HEAD is $head, not the target"; fi
}

# install.sh, with the unit's environment and install.env's inputs. Its output passes through; its last line says
# whether it changed the profile.
run_install() {
  begin 'running deploy/install.sh'
  local line last=''
  env -u DISH_UPDATE_CLEAN -u DISH_UPDATE_PARENT -u DISH_UPDATE_WAIT "PATH=$target_path" \
    "DISH_REMOTE=$remote" "DISH_USER_NAME=$user_name" "DISH_USER_EMAIL=$user_email" \
    "$checkout/deploy/install.sh" </dev/null 9>&- |
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%s\n' "$line"
      last=$line
    done
  case $last in
    'install: profile changed') profile_changed=1 ;;
    'install: no changes to the profile') profile_changed=0 ;;
    *) fail 'deploy/install.sh did not end with its summary line (install: profile changed, or install: no changes to the profile)' ;;
  esac
}

install_the_unit() {
  step='comparing the installed unit'
  local dir=$home/.config/systemd/user tmp source_sum installed_sum='' enabled
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
    step='reloading the user manager'
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

restart_when_stale() {
  step='deciding whether to restart'
  local unit_sum
  unit_sum=$(sha256 "$checkout/deploy/$UNIT")
  make_stamp "$head" "$unit_sum"
  stale_reasons
  if [ "$profile_changed" -eq 1 ]; then reasons+=('install.sh changed the profile'); fi
  restarted=0
  if [ "${#reasons[@]}" -eq 0 ]; then
    say 'restart: not needed'
    return 0
  fi
  say "restart: needed ($(joined_reasons))"
  begin "restarting $UNIT"
  systemctl --user restart "$UNIT"
  restarted=1
}

# Any HTTP answer, even a 401 for the missing sign-in, means dsh is up.
wait_for_dsh() {
  begin "waiting for dsh on $LISTEN"
  local deadline=$((SECONDS + wait_seconds)) code
  while :; do
    code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$LISTEN/" 9>&-) || true
    if [ -n "$code" ] && [ "$code" != 000 ]; then return 0; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      if [ "${DISH_UPDATE_PARENT-}" != root ]; then print_journal_as_the_account; fi
      fail "dsh did not answer on $LISTEN within $wait_seconds seconds"
    fi
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

print_journal_as_the_account() {
  print_journal "journal: not readable as $account; run update.sh as root to see it" --user -u "$UNIT" -n 15 --no-pager
}

print_the_result() {
  step='printing the result'
  local active how=unchanged
  active=$(systemctl --user is-active "$UNIT" 2>/dev/null) || true
  if [ "$restarted" -eq 1 ]; then how=restarted; fi
  say "HEAD $head"
  say "$UNIT: ${active:-unknown} ($how)"
  if [ "$restarted" -eq 1 ]; then say "run $checkout/deploy/url.sh for a fresh sign-in link"; fi
  if [ "${DISH_UPDATE_PARENT-}" != root ]; then print_journal_as_the_account; fi
  step=''
}

# The work, as the account, in the clean environment.
update() {
  cd -- "$home"
  refuse_a_borrowed_environment
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

  # The first change.
  move_the_checkout
  run_install
  install_the_unit
  restart_when_stale
  wait_for_dsh
  if [ "$restarted" -eq 1 ]; then write_the_stamp; fi
  print_the_result
}

main() {
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  args=("$@")
  parse_arguments "$@"
  find_the_account

  step='checking who runs update.sh'
  local me
  me=$(id -u)
  if [ "$me" = 0 ]; then run_as_the_account; fi
  me=$(id -un)
  if [ "$me" != "$account" ]; then
    step=''
    warn "run update.sh as root or as $account"
    exit 2
  fi
  if [ -z "${DISH_UPDATE_CLEAN+x}" ]; then run_clean; fi
  update
}

main "$@"; exit
