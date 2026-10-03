#!/usr/bin/env bash
# Install dish into a dsh profile: build, create the profile, write dish's rows, link its bundles.
#
# Run it from anywhere as the account that runs `dsh web` (it moves to the checkout's root itself). It is idempotent: a
# second run changes nothing, and says so on its last line.
#
# Inputs, all from the environment:
#   DISH_REMOTE      the config store's git remote, e.g. git@github-dish-config:bketelsen/dish-config.git. Required.
#                    Set but empty, the store stays local: no remote is written.
#   DISH_USER_NAME   the store's commit author name. Required.
#   DISH_USER_EMAIL  the store's commit author email. Required.
#   DISH_PROFILE     the dsh profile to install into. Default `web`.
#   DISH_SANDBOX_HOME  `on` runs every sandboxed agent command through deploy/dish-sandbox, which lets it write the home
#                    directory less a protected list: the profile's `sandbox` row gets it as its runnerCommand. `off`,
#                    empty or unset takes that away again. update.sh (the VM) sets it to `on`; dev leaves it off unless
#                    you set it (docs/specs/sandbox-home.md).
# The profile lives under $DSH_HOME (default ~/.dsh). Nothing here is secret, and nothing here is printed that is.
#
# Steps, in order. A failure stops the script and names the step on stderr:
#   1. pnpm install --frozen-lockfile, then pnpm build
#   2. create the profile when it is missing, and have its pnpm installs copy (deploy/pnpm-copies.ts)
#   3. write dish's rows into the profile's cordis.patch.yml (deploy/profile.ts), the sandbox row included
#   4. link the bundles that are not linked yet
#   5. replace the files in the checkout's and the profile's node_modules that are hard links into pnpm's store
#
# Copies, not links (steps 2 and 5). pnpm hard-links its store's files into node_modules where it can (the VM's ext4),
# so the checkout's files would share their inodes with every agent's project, and with DISH_SANDBOX_HOME on a sandboxed
# command can write the store and those projects. The checkout's pnpm-workspace.yaml and the profile's say
# `packageImportMethod: clone-or-copy`, and step 5 copies what earlier installs linked, which pnpm never re-imports.
# None of this touches the store itself, or which store is used (the store-pin contract below).
#
# The rows go in before the bundles on purpose. The dish-config row patches a row that the config bundle inserts, so
# between steps 3 and 4 it has no target. dsh only complains about that when it composes the profile (`--dump-config`
# or a boot), and nothing here composes the profile in between: `dsh plugin ... add` runs pnpm and reads the bundles'
# manifests, and does not load the patch file.
#
# Every dsh command runs with the four XDG directories pointing into a throwaway directory. dsh commands that load a
# profile boot its plugins, and dish-config opens or creates $XDG_CONFIG_HOME/dish/config.git when it boots. An install
# that did that on a fresh machine would leave an empty local store, and the first start with a remote would then push
# that store over the one on GitHub instead of restoring it. In dsh 0.2.0-rc.2 `--dump-config` and `plugin ... add` do
# not boot anything (the first composes patch files, the second runs pnpm), so this is a guard against a later dsh, not
# a fix. HOME and DSH_HOME stay real, so the profile lands where `dsh web` reads it. Under `pnpm dev` the launcher sets
# DSH_DISH_HOME, which moves dish's directories ahead of XDG_*, so run_dsh removes it: otherwise the throwaway
# directories would do nothing there.
#
# One thing in those directories has to stay put: pnpm's store. pnpm finds it under $PNPM_HOME, else $XDG_DATA_HOME,
# records it in the profile's node_modules/.modules.yaml, and refuses (ERR_PNPM_UNEXPECTED_STORE) to work on that
# profile with any other. A throwaway store would break every later `plugin add`, and the plugin manager inside dsh web.
# So the store pnpm would use for this account is looked up first, and handed to the dsh commands as
# pnpm_config_store_dir.
#
# The store-pin contract: the pinned store is whatever `pnpm store path` prints in the environment this script runs
# with, while dsh's own plugin manager works the store out again from the environment of the dish-web unit, which sets
# none of HOME, XDG_DATA_HOME or PNPM_HOME. The two must give the same store, so HOME, XDG_DATA_HOME and PNPM_HOME have
# to be the same for the install and for the unit. Neither this script's caller (fleet) nor the unit may set one of them
# for just one of the two.

set -euo pipefail

step='checking the inputs'
scratch=''

# Name the step that is starting, so a failure can say which one it was.
begin() {
  step=$1
  echo "install: $step"
}

cleanup() {
  local status=$?
  if [ -n "$scratch" ]; then rm -rf -- "$scratch"; fi
  if [ "$status" -ne 0 ]; then echo "install: FAILED at step: $step (exit $status)" >&2; fi
}
trap cleanup EXIT
# A signal ends the script through the EXIT trap, so the throwaway directory goes too.
trap 'exit 130' INT
trap 'exit 143' TERM HUP

: "${DISH_REMOTE?DISH_REMOTE must be set: the git remote of the config store, or set empty to keep the store local}"
: "${DISH_USER_NAME:?DISH_USER_NAME must be set: the commit author name for the config store}"
: "${DISH_USER_EMAIL:?DISH_USER_EMAIL must be set: the commit author email for the config store}"
profile=${DISH_PROFILE:-web}
case ${DISH_SANDBOX_HOME-} in
  on) sandbox_home=on ;;
  off | '') sandbox_home=off ;;
  *)
    echo "install: DISH_SANDBOX_HOME must be on or off (unset means off), not \"$DISH_SANDBOX_HOME\"" >&2
    exit 1
    ;;
esac

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$root"

step='checking that node and pnpm are on PATH'
for tool in node pnpm; do
  command -v "$tool" >/dev/null || { echo "install: $tool is not on PATH" >&2; exit 1; }
done

step="finding pnpm's store"
pnpm_store=$(pnpm store path)
if [[ $pnpm_store != /* || $pnpm_store == *$'\n'* ]]; then
  echo 'install: pnpm store path did not print a single absolute path' >&2
  exit 1
fi
step="making the throwaway directory in ${TMPDIR:-/tmp}"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/dish-install.XXXXXX")

# dsh, from this checkout, with its XDG directories in the throwaway one, DSH_DISH_HOME removed, and pnpm's store where
# it always is.
run_dsh() {
  env -u DSH_DISH_HOME \
    XDG_CONFIG_HOME="$scratch/config" XDG_STATE_HOME="$scratch/state" \
    XDG_DATA_HOME="$scratch/data" XDG_CACHE_HOME="$scratch/cache" \
    pnpm_config_store_dir="$pnpm_store" \
    pnpm exec dsh "$@"
}

bundles=(copilot config prompts skills crew judge web)
profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/$profile"
patch="$profile_dir/cordis.patch.yml"
changed=0

# Whether the profile's package.json links the plugin in ./plugins/<name> and lists it as a bundle.
bundle_state() {
  node -e '
    const { readFileSync } = require("node:fs")
    const profile = JSON.parse(readFileSync(process.argv[1], "utf8"))
    const name = JSON.parse(readFileSync(process.argv[2] + "/package.json", "utf8")).name
    const spec = profile.dependencies?.[name]
    const listed = (profile.dsh?.profile?.bundles ?? []).includes(name)
    console.log(typeof spec === "string" && spec.startsWith("link:") && listed ? "linked" : "missing")
  ' "$profile_dir/package.json" "plugins/$1"
}

begin 'pnpm install --frozen-lockfile'
pnpm install --frozen-lockfile

begin 'pnpm build'
pnpm build

begin "making sure the $profile profile exists"
profile_made=existing
if [ ! -f "$profile_dir/package.json" ]; then
  if [ "$profile" = web ]; then
    # `web` is one of dsh's shipped profiles: dsh makes it on first use, and refuses --from-default-profile for it.
    run_dsh --profile "$profile" --dump-config >/dev/null
  else
    run_dsh --profile "$profile" --from-default-profile web --dump-config >/dev/null
  fi
  profile_made=created
  changed=1
fi

# dsh wrote the profile's pnpm-workspace.yaml when it made the profile; dsh's plugin manager runs pnpm there later too.
begin "having the $profile profile's pnpm installs copy"
profile_copies=$(node deploy/pnpm-copies.ts --workspace "$profile_dir/pnpm-workspace.yaml")

begin "writing dish's rows into $patch"
remote_args=(--no-remote)
remote_shown='none, the store stays local'
if [ -n "$DISH_REMOTE" ]; then
  remote_args=("--remote=$DISH_REMOTE")
  remote_shown=$DISH_REMOTE
fi
sandbox_args=(--no-sandbox-runner)
if [ "$sandbox_home" = on ]; then sandbox_args=("--sandbox-runner=$root/deploy/dish-sandbox"); fi
# The --opt=value form, so that a value that starts with a dash is not read as another option.
rows=$(node deploy/profile.ts --patch "$patch" "${remote_args[@]}" "--user-name=$DISH_USER_NAME" "--user-email=$DISH_USER_EMAIL" "${sandbox_args[@]}")
if [ "$rows" != unchanged ]; then changed=1; fi

added=()
linked=()
for name in "${bundles[@]}"; do
  step="checking whether the $name bundle is linked"
  state=$(bundle_state "$name")
  if [ "$state" = linked ]; then
    linked+=("$name")
    continue
  fi
  begin "linking the $name bundle"
  run_dsh plugin --profile "$profile" add "./plugins/$name"
  added+=("$name")
  changed=1
done

begin "replacing hard links into pnpm's store with copies"
unlinked=$(node deploy/pnpm-copies.ts --unlink "$root/node_modules" --unlink "$profile_dir/node_modules")
copied=0
while read -r _ count _; do copied=$((copied + count)); done <<<"$unlinked"

step='printing the summary'
echo "install: profile $profile at $profile_dir: $profile_made"
echo "install: dish rows ($remote_shown): $rows"
echo "install: sandbox home: $sandbox_home"
echo "install: the profile's pnpm installs copy: ${profile_copies#workspace: }"
echo "install: links into pnpm's store replaced by copies: $copied"
echo "install: bundles added: ${added[*]:-none}; already linked: ${linked[*]:-none}"
if [ "$changed" -eq 0 ]; then
  echo 'install: no changes to the profile'
else
  echo 'install: profile changed'
fi
