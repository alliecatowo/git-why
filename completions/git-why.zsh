#compdef git-why git why
# zsh completion for git-why.
#
# Install: put this on $fpath as _git-why, e.g.
#   mkdir -p ~/.zsh/completions && cp git-why.zsh ~/.zsh/completions/_git-why
#   echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc

_git-why() {
  local -a commands sorts refreshes
  commands=(
    'index:Build or refresh the index for this repository'
    'status:Report index state, coverage, and disk use'
    'rebuild:Rebuild the index from scratch'
    'gc:Reclaim disk from superseded generations'
    'help:Show help'
    'server:Start, stop or inspect the shared daemon'
    'completion:Emit a shell completion script'
  )
  sorts=('relevance:Ranked by relevance (default)' 'oldest:Chronological' 'newest:Reverse chronological')
  refreshes=('off:Never refresh; fail if stale' 'wait:Refresh before querying')
  daemons=('direct:Never contact the daemon' 'server:Require a running daemon' 'auto:Use one when running (default)')

  _arguments -C \
    '(--text --semantic)--text[Full-text search only]' \
    '(--text --semantic)--semantic[Vector search only]' \
    '--json[Emit one JSON object on stdout]' \
    '--owners[Aggregate matched commits by author]' \
    '--first[Resolve when something was first introduced]' \
    '--last[Resolve the most recent change]' \
    '--removed[Resolve when something was removed]' \
    '--timeline[Return the history-oriented view]' \
    '--before=[Only commits before an anchor]:anchor:' \
    '--after=[Only commits after an anchor]:anchor:' \
    '--around=[Prefer commits near an anchor]:anchor:' \
    '--group=[Additional query group, fused by RRF]:query:' \
    '--sort=[Result ordering]:order:((${sorts}))' \
    '--refresh=[Refresh policy]:policy:((${refreshes}))' \
    '--no-refresh[Alias for --refresh=off]' \
    '--if-needed[index: skip when already current]' \
    '--check-ready[status: exit 0 only when current]' \
    '--offline[Never download model artifacts]' \
    '--verbose[Progress and diagnostics on stderr]' \
    '--author=[Restrict to an author]:author:' \
    '--between=[Prefer commits between two anchors]:a,b:' \
    '--query[Explicit query text, for text that looks like an option]:text:' \
    '--max-bytes=[Bound rendered output, including JSON framing]:bytes:' \
    '--lock-timeout=[Seconds to wait for another process]:seconds:' \
    '--use-default-model[rebuild: re-embed with the default model]' \
    '--daemon=[Daemon routing]:mode:((${daemons}))' \
    '-n[Number of commits to return]:count:' \
    '--help[Show help]' \
    '--version[Show version]' \
    '1: :->cmd' \
    '*:: :->args'

  case $state in
    cmd) _describe -t commands 'git why command' commands ;;
  esac
}

_git-why "$@"
