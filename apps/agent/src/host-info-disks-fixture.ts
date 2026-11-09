// Real `/proc/self/mountinfo` and `env LC_ALL=C df --all -B1 -P` of two qualification guests, read in one shell on 2026-11-09
// with the namespace unchanged between them. systemd mounts an autofs placeholder under binfmt_misc and, on EL, /efi;
// df prints it as a row of `-` sizes. Rocky Linux 9 shows both triggered; Ubuntu 24.04 shows binfmt_misc.

export const ROCKY9_MOUNTINFO = `23 73 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:14 - proc proc rw
24 73 0:23 / /sys rw,nosuid,nodev,noexec,relatime shared:3 - sysfs sysfs rw,seclabel
25 73 0:6 / /dev rw,nosuid shared:10 - devtmpfs devtmpfs rw,seclabel,size=2857716k,nr_inodes=714429,mode=755,inode64
26 24 0:7 / /sys/kernel/security rw,nosuid,nodev,noexec,relatime shared:4 - securityfs securityfs rw
27 25 0:24 / /dev/shm rw,nosuid,nodev shared:11 - tmpfs tmpfs rw,seclabel,inode64
28 25 0:25 / /dev/pts rw,nosuid,noexec,relatime shared:12 - devpts devpts rw,seclabel,gid=5,mode=620,ptmxmode=000
29 73 0:26 / /run rw,nosuid,nodev shared:13 - tmpfs tmpfs rw,seclabel,size=1160292k,nr_inodes=819200,mode=755,inode64
30 24 0:27 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:5 - cgroup2 cgroup2 rw,seclabel,nsdelegate,memory_recursiveprot
31 24 0:28 / /sys/fs/pstore rw,nosuid,nodev,noexec,relatime shared:6 - pstore pstore rw,seclabel
32 24 0:29 / /sys/fs/bpf rw,nosuid,nodev,noexec,relatime shared:7 - bpf bpf rw,mode=700
67 24 0:18 / /sys/kernel/config rw,nosuid,nodev,noexec,relatime shared:8 - configfs configfs rw
73 1 8:4 / / rw,relatime shared:1 - xfs /dev/sda4 rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota
76 73 0:34 / /var/lib/nfs/rpc_pipefs rw,relatime shared:2 - rpc_pipefs rpc_pipefs rw
34 24 0:21 / /sys/fs/selinux rw,nosuid,noexec,relatime shared:9 - selinuxfs selinuxfs rw
33 23 0:30 / /proc/sys/fs/binfmt_misc rw,relatime shared:15 - autofs systemd-1 rw,fd=29,pgrp=1,timeout=0,minproto=5,maxproto=5,direct,pipe_ino=936
35 25 0:31 / /dev/hugepages rw,relatime shared:16 - hugetlbfs hugetlbfs rw,seclabel,pagesize=2M
36 25 0:20 / /dev/mqueue rw,nosuid,nodev,noexec,relatime shared:17 - mqueue mqueue rw,seclabel
37 24 0:8 / /sys/kernel/debug rw,nosuid,nodev,noexec,relatime shared:18 - debugfs debugfs rw,seclabel
38 24 0:13 / /sys/kernel/tracing rw,nosuid,nodev,noexec,relatime shared:19 - tracefs tracefs rw,seclabel
39 24 0:32 / /sys/fs/fuse/connections rw,nosuid,nodev,noexec,relatime shared:20 - fusectl fusectl rw
62 29 0:33 / /run/credentials/systemd-sysctl.service ro,nosuid,nodev,noexec,relatime shared:21 - ramfs none rw,seclabel,mode=700
64 29 0:35 / /run/credentials/systemd-tmpfiles-setup-dev.service ro,nosuid,nodev,noexec,relatime shared:22 - ramfs none rw,seclabel,mode=700
40 73 0:36 / /efi rw,relatime shared:23 - autofs systemd-1 rw,fd=51,pgrp=1,timeout=120,minproto=5,maxproto=5,direct,pipe_ino=22427
95 73 8:16 / /home rw,relatime shared:43 - xfs /dev/sdb rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,usrquota
98 73 8:3 / /boot rw,relatime shared:50 - xfs /dev/sda3 rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota
101 98 8:2 / /boot/efi rw,relatime shared:52 - vfat /dev/sda2 rw,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro
132 29 0:37 / /run/credentials/systemd-tmpfiles-setup.service ro,nosuid,nodev,noexec,relatime shared:54 - ramfs none rw,seclabel,mode=700
1027 33 0:55 / /proc/sys/fs/binfmt_misc rw,nosuid,nodev,noexec,relatime shared:297 - binfmt_misc binfmt_misc rw
1057 40 8:2 / /efi rw,relatime shared:568 - vfat /dev/sda2 rw,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro
818 29 0:47 / /run/user/0 rw,nosuid,nodev,relatime shared:247 - tmpfs tmpfs rw,seclabel,size=580144k,nr_inodes=145036,mode=700,inode64
`

export const ROCKY9_DF = `Filesystem        1-blocks       Used   Available Capacity Mounted on
proc                     0          0           0        - /proc
sysfs                    0          0           0        - /sys
devtmpfs        2926301184          0  2926301184       0% /dev
securityfs               0          0           0        - /sys/kernel/security
tmpfs           2970341376      16384  2970324992       1% /dev/shm
devpts                   0          0           0        - /dev/pts
tmpfs           1188139008     634880  1187504128       1% /run
cgroup2                  0          0           0        - /sys/fs/cgroup
pstore                   0          0           0        - /sys/fs/pstore
bpf                      0          0           0        - /sys/fs/bpf
configfs                 0          0           0        - /sys/kernel/config
/dev/sda4      33136029696 4420861952 28715167744      14% /
rpc_pipefs               0          0           0        - /var/lib/nfs/rpc_pipefs
selinuxfs                0          0           0        - /sys/fs/selinux
systemd-1                -          -           -        - /proc/sys/fs/binfmt_misc
hugetlbfs                0          0           0        - /dev/hugepages
mqueue                   0          0           0        - /dev/mqueue
debugfs                  0          0           0        - /sys/kernel/debug
tracefs                  0          0           0        - /sys/kernel/tracing
fusectl                  0          0           0        - /sys/fs/fuse/connections
none                     0          0           0        - /run/credentials/systemd-sysctl.service
none                     0          0           0        - /run/credentials/systemd-tmpfiles-setup-dev.service
systemd-1                -          -           -        - /efi
/dev/sdb       17112760320  153288704 16959471616       1% /home
/dev/sda3        981467136  545210368   436256768      56% /boot
/dev/sda2        104607744   11618304    92989440      12% /boot/efi
none                     0          0           0        - /run/credentials/systemd-tmpfiles-setup.service
binfmt_misc              0          0           0        - /proc/sys/fs/binfmt_misc
/dev/sda2        104607744   11618304    92989440      12% /efi
tmpfs            594067456          0   594067456       0% /run/user/0
`

export const UBUNTU2404_MOUNTINFO = `24 29 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw
25 29 0:23 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
26 29 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=2992192k,nr_inodes=748048,mode=755,inode64
27 26 0:24 / /dev/pts rw,nosuid,noexec,relatime shared:3 - devpts devpts rw,gid=5,mode=620,ptmxmode=000
28 29 0:25 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=606812k,mode=755,inode64
29 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,discard,errors=remount-ro,commit=30
30 24 0:6 / /sys/kernel/security rw,nosuid,nodev,noexec,relatime shared:8 - securityfs securityfs rw
31 26 0:26 / /dev/shm rw,nosuid,nodev shared:4 - tmpfs tmpfs rw,inode64
32 28 0:27 / /run/lock rw,nosuid,nodev,noexec,relatime shared:6 - tmpfs tmpfs rw,size=5120k,inode64
33 24 0:28 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot
34 24 0:29 / /sys/fs/pstore rw,nosuid,nodev,noexec,relatime shared:10 - pstore pstore rw
35 24 0:30 / /sys/fs/bpf rw,nosuid,nodev,noexec,relatime shared:11 - bpf bpf rw,mode=700
36 25 0:31 / /proc/sys/fs/binfmt_misc rw,relatime shared:13 - autofs systemd-1 rw,fd=32,pgrp=1,timeout=0,minproto=5,maxproto=5,direct,pipe_ino=4212
37 26 0:32 / /dev/hugepages rw,nosuid,nodev,relatime shared:14 - hugetlbfs hugetlbfs rw,pagesize=2M
38 26 0:20 / /dev/mqueue rw,nosuid,nodev,noexec,relatime shared:15 - mqueue mqueue rw
39 24 0:7 / /sys/kernel/debug rw,nosuid,nodev,noexec,relatime shared:16 - debugfs debugfs rw
40 24 0:12 / /sys/kernel/tracing rw,nosuid,nodev,noexec,relatime shared:17 - tracefs tracefs rw
41 24 0:33 / /sys/fs/fuse/connections rw,nosuid,nodev,noexec,relatime shared:18 - fusectl fusectl rw
42 24 0:21 / /sys/kernel/config rw,nosuid,nodev,noexec,relatime shared:19 - configfs configfs rw
44 29 8:16 / /home rw,relatime shared:29 - ext4 /dev/sdb rw,jqfmt=vfsv1,usrjquota=aquota.user
46 29 259:0 / /boot rw,relatime shared:44 - ext4 /dev/sda16 rw
48 46 8:15 / /boot/efi rw,relatime shared:46 - vfat /dev/sda15 rw,fmask=0077,dmask=0077,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro
125 36 0:38 / /proc/sys/fs/binfmt_misc rw,nosuid,nodev,noexec,relatime shared:48 - binfmt_misc binfmt_misc rw
89 28 0:71 / /run/user/0 rw,nosuid,nodev,relatime shared:183 - tmpfs tmpfs rw,size=606808k,nr_inodes=151702,mode=700,inode64
`

export const UBUNTU2404_DF = `Filesystem        1-blocks       Used   Available Capacity Mounted on
sysfs                    0          0           0        - /sys
proc                     0          0           0        - /proc
udev            3064004608          0  3064004608       0% /dev
devpts                   0          0           0        - /dev/pts
tmpfs            621375488    1150976   620224512       1% /run
/dev/sda1      32162967552 7375060992 24771129344      23% /
securityfs               0          0           0        - /sys/kernel/security
tmpfs           3106861056    2281472  3104579584       1% /dev/shm
tmpfs              5242880          0     5242880       0% /run/lock
cgroup2                  0          0           0        - /sys/fs/cgroup
pstore                   0          0           0        - /sys/fs/pstore
bpf                      0          0           0        - /sys/fs/bpf
systemd-1                -          -           -        - /proc/sys/fs/binfmt_misc
hugetlbfs                0          0           0        - /dev/hugepages
mqueue                   0          0           0        - /dev/mqueue
debugfs                  0          0           0        - /sys/kernel/debug
tracefs                  0          0           0        - /sys/kernel/tracing
fusectl                  0          0           0        - /sys/fs/fuse/connections
configfs                 0          0           0        - /sys/kernel/config
/dev/sdb       16729894912     155648 15853969408       1% /home
/dev/sda16       923156480  213393408   645120000      25% /boot
/dev/sda15       109395456    6399488   102995968       6% /boot/efi
binfmt_misc              0          0           0        - /proc/sys/fs/binfmt_misc
tmpfs            621371392      12288   621359104       1% /run/user/0
`
