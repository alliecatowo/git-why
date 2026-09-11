# bash completion for git-why.
#
# Install:  source this file, or drop it in /usr/local/etc/bash_completion.d/
# Also completes `git why ...` because Git dispatches unknown subcommands to
# git-why(1), and a completion that only fired for the hyphenated form would
# miss the way people actually type it.

_git_why_complete() {
  local cur prev words cword
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local commands="index status rebuild gc help completion"
  local flags="--text --semantic --json --owners --first --last --removed --timeline \
--sort= --before= --after= --between= --around= --group= --refresh= --no-refresh \
--if-needed --check-ready --use-default-model --offline --verbose --max-bytes= \
--lock-timeout= --author= --query --help --version -n"

  case "$prev" in
    --sort) COMPREPLY=( $(compgen -W "relevance oldest newest" -- "$cur") ); return ;;
    --refresh) COMPREPLY=( $(compgen -W "off wait" -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  elif [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  fi
}

complete -F _git_why_complete git-why
