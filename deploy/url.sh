#!/usr/bin/env bash
# Print the link that signs you in to dish: https://<DISH_TRUSTED_HOST>/?token=<token>
#
# Run it on the VM as root through fleet's wrapper, which `incus exec` reaches:
#   incus exec dish --project dish -- dish-url
# It takes no arguments.
#
# It runs only as the account: the owner of the checkout this script sits in (`dish` on the VM). Never as root: this
# file is the account's to write, so root running it would run whatever the account (or an agent acting as it) put
# here. Root's entry point is /usr/local/sbin/dish-url, a root-owned wrapper fleet installs, which runs this script as
# the account through runuser with a minimal environment and does nothing else.
#
# It prints a secret, on purpose: the token. It is for your terminal. Don't paste the output anywhere.
#
# stdout is exactly one line, the link, and nothing else, ever. Everything else it says goes to stderr, and the token is
# never in any of it. Exit 0: the link was printed. Exit 1: the service isn't running, hasn't printed a token since its
# current start, or deploy.env is missing or unusable. Exit 2: an argument, or not run as the account.
#
# How it works:
#   1. The account is the owner of the checkout this script sits in (`dish` on the VM). Its uid and home come from
#      `getent passwd`.
#   2. The host comes from <home>/.config/dish/deploy.env, the file fleet writes and the unit loads.
#   3. The start comes from the account's user manager: `systemctl --user show dish-web.service`, with
#      XDG_RUNTIME_DIR=/run/user/<uid>.
#   4. dsh makes a new token at every start and prints the link to stdout, which the unit sends to the journal. The
#      token is in the last `dsh web: ` line since the current start, read from the account's own user journal.
#
# It changes nothing: no file is written, and the token never touches a file or another program's arguments.
#
# The whole body is a function, called on the last line, so that the file can be replaced while it runs.

set -euo pipefail
# A shell trace in the environment (SHELLOPTS, BASH_ENV) would print the journal's lines, token included, to stderr.
set +o xtrace

step='starting'
reported=0

# Say why on stderr and stop. Nothing here ever prints a journal line.
die() {
  local code=$1
  shift
  reported=1
  echo "url: $*" >&2
  exit "$code"
}

# shellcheck disable=SC2317,SC2329  # run by the EXIT trap below (shellcheck loses sight of the trap before `main "$@"; exit`); 0.10 calls it SC2317, 0.11 SC2329
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$reported" -eq 0 ]; then echo "url: FAILED at step: $step (exit $status)" >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

main() {
  if [ "$#" -ne 0 ]; then die 2 'takes no arguments'; fi

  step='finding the account'
  local self root account entry uid home me
  # The script's real path, so that a symlink to it still finds the checkout it sits in.
  self=$(readlink -f -- "${BASH_SOURCE[0]}")
  root=$(cd -- "$(dirname -- "$self")/.." && pwd -P)
  account=$(stat -c %U -- "$root")
  if [ "$account" = root ]; then die 1 "$root is owned by root; url.sh needs the account that runs dish-web.service to own the checkout"; fi

  step='checking who runs it'
  local refused="run dish-url as root (incus exec dish --project dish -- dish-url), or this script as $account"
  me=$(id -u)
  if [ "$me" = 0 ]; then die 2 "$refused"; fi

  step="finding the account's home"
  entry=$(getent passwd "$account") || die 1 "can't look up the account $account (the owner of $root) with getent"
  IFS=: read -r _ _ uid _ _ home _ <<<"$entry"
  if [[ ! $uid =~ ^[0-9]+$ || $home != /* ]]; then die 1 "getent gave no uid and home for the account $account"; fi
  if [ "$me" != "$uid" ]; then die 2 "$refused"; fi

  step='reading deploy.env'
  local env_file="$home/.config/dish/deploy.env"
  if [ ! -f "$env_file" ]; then die 1 "$env_file doesn't exist; fleet's dish_guest play writes it"; fi
  local line host='' hosts=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line == DISH_TRUSTED_HOST=* ]]; then
      host=${line#DISH_TRUSTED_HOST=}
      hosts=$((hosts + 1))
    fi
  done <"$env_file"
  local host_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$'
  if [ "$hosts" -ne 1 ] || [[ ! $host =~ $host_re ]]; then
    die 1 "$env_file needs exactly one DISH_TRUSTED_HOST=<host> line with a bare host name (no scheme or path), and fleet's dish_guest play writes it"
  fi

  step="asking $account's user manager about dish-web.service"
  local show
  show=$(XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user show dish-web.service --property=MainPID --property=ExecMainStartTimestamp) ||
    die 1 "can't ask $account's user manager about dish-web.service (XDG_RUNTIME_DIR=/run/user/$uid; is linger on?)"
  local main_pid='' started=''
  while IFS= read -r line; do
    case $line in
      MainPID=*) main_pid=${line#MainPID=} ;;
      ExecMainStartTimestamp=*) started=${line#ExecMainStartTimestamp=} ;;
    esac
  done <<<"$show"
  if [[ ! $main_pid =~ ^[0-9]+$ ]]; then die 1 "systemctl show gave no MainPID for dish-web.service"; fi
  if [ "$main_pid" -eq 0 ]; then die 1 "dish-web.service isn't running; start it with dish-update --apply"; fi
  if [ -z "$started" ]; then die 1 "systemctl show gave no start time for dish-web.service"; fi

  step='reading the journal'
  local journal
  journal=$(journalctl --user -u dish-web.service --since "$started" -q --no-pager -o cat) ||
    die 1 "can't read the journal of dish-web.service since $started"
  # Process substitution, not a here-string: older bash writes a here-string to a temporary file.
  local token='' token_re='[?&]token=([A-Za-z0-9_-]+)'
  while IFS= read -r line; do
    if [[ $line == 'dsh web: '* && $line =~ $token_re ]]; then token=${BASH_REMATCH[1]}; fi
  done < <(printf '%s\n' "$journal")
  if [ -z "$token" ]; then
    die 1 "dsh hasn't printed its sign-in line since it started at $started; try again in a few seconds"
  fi

  step='printing the link'
  printf 'https://%s/?token=%s\n' "$host" "$token"
}

main "$@"; exit
