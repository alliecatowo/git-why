# fish completion for git-why.
# Install: cp git-why.fish ~/.config/fish/completions/

complete -c git-why -f

complete -c git-why -n __fish_use_subcommand -a index -d 'Build or refresh the index'
complete -c git-why -n __fish_use_subcommand -a status -d 'Report index state and disk use'
complete -c git-why -n __fish_use_subcommand -a rebuild -d 'Rebuild from scratch'
complete -c git-why -n __fish_use_subcommand -a gc -d 'Reclaim disk from old generations'
complete -c git-why -n __fish_use_subcommand -a completion -d 'Emit a shell completion script'

complete -c git-why -l text -d 'Full-text search only'
complete -c git-why -l semantic -d 'Vector search only'
complete -c git-why -l json -d 'One JSON object on stdout'
complete -c git-why -l owners -d 'Aggregate matched commits by author'
complete -c git-why -l first -d 'When was this first introduced'
complete -c git-why -l last -d 'Most recent change'
complete -c git-why -l removed -d 'When was this removed'
complete -c git-why -l timeline -d 'History-oriented view'
complete -c git-why -l sort -a 'relevance oldest newest' -d 'Result ordering'
complete -c git-why -l refresh -a 'off wait' -d 'Refresh policy'
complete -c git-why -l no-refresh -d 'Alias for --refresh=off'
complete -c git-why -n '__fish_seen_subcommand_from index' -l if-needed -d 'Skip when already current'
complete -c git-why -n '__fish_seen_subcommand_from status' -l check-ready -d 'Exit 0 only when current'
complete -c git-why -l offline -d 'Never download model artifacts'
complete -c git-why -l verbose -d 'Progress on stderr'
complete -c git-why -l help -d 'Show help'
complete -c git-why -l version -d 'Show version'
