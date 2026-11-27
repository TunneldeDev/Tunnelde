export LC_ALL=C
printf '#process-native-meta\nmacos %s %s\n' "$(sysctl -n hw.logicalcpu)" "$(sysctl -n hw.memsize)"
echo '#process-macos'
# BSD ps has no nlwp column. Missing thread/IO/driver metrics stay unavailable.
ps -ww -axo pid=,uid=,gid=,user=,group=,ppid=,stat=,rss=,lstart=,time=,comm= 2>/dev/null
