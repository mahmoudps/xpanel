// os-release(5) samples as shipped by each distribution, for tests.

export const UBUNTU_2204 = `PRETTY_NAME="Ubuntu 22.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
VERSION_CODENAME=jammy
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=jammy
`

export const UBUNTU_2404 = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
`

export const CENTOS_STREAM_9 = `NAME="CentOS Stream"
VERSION="9"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="9"
PLATFORM_ID="platform:el9"
PRETTY_NAME="CentOS Stream 9"
ANSI_COLOR="0;31"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:centos:centos:9"
HOME_URL="https://centos.org/"
BUG_REPORT_URL="https://issues.redhat.com/"
REDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux 9"
REDHAT_SUPPORT_PRODUCT_VERSION="CentOS Stream"
`

export const CENTOS_STREAM_10 = `NAME="CentOS Stream"
VERSION="10 (Coughlan)"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="10"
PLATFORM_ID="platform:el10"
PRETTY_NAME="CentOS Stream 10 (Coughlan)"
ANSI_COLOR="0;31"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:centos:centos:10"
HOME_URL="https://centos.org/"
VENDOR_NAME="CentOS"
VENDOR_URL="https://centos.org/"
BUG_REPORT_URL="https://issues.redhat.com/"
REDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux 10"
REDHAT_SUPPORT_PRODUCT_VERSION="CentOS Stream"
`

export const ALMA_9 = `NAME="AlmaLinux"
VERSION="9.4 (Seafoam Ocelot)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="AlmaLinux 9.4 (Seafoam Ocelot)"
ANSI_COLOR="0;34"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:almalinux:almalinux:9::baseos"
HOME_URL="https://almalinux.org/"
DOCUMENTATION_URL="https://wiki.almalinux.org/"
BUG_REPORT_URL="https://bugs.almalinux.org/"

ALMALINUX_MANTISBT_PROJECT="AlmaLinux-9"
ALMALINUX_MANTISBT_PROJECT_VERSION="9.4"
REDHAT_SUPPORT_PRODUCT="AlmaLinux"
REDHAT_SUPPORT_PRODUCT_VERSION="9.4"
SUPPORT_END=2032-06-01
`

export const ALMA_10 = `NAME="AlmaLinux"
VERSION="10.0 (Purple Lion)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="10.0"
PLATFORM_ID="platform:el10"
PRETTY_NAME="AlmaLinux 10.0 (Purple Lion)"
ANSI_COLOR="0;34"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:almalinux:almalinux:10::baseos"
HOME_URL="https://almalinux.org/"
DOCUMENTATION_URL="https://wiki.almalinux.org/"
BUG_REPORT_URL="https://bugs.almalinux.org/"

ALMALINUX_MANTISBT_PROJECT="AlmaLinux-10"
ALMALINUX_MANTISBT_PROJECT_VERSION="10.0"
REDHAT_SUPPORT_PRODUCT="AlmaLinux"
REDHAT_SUPPORT_PRODUCT_VERSION="10.0"
SUPPORT_END=2035-06-01
`

export const ROCKY_9 = `NAME="Rocky Linux"
VERSION="9.4 (Blue Onyx)"
ID="rocky"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"
ANSI_COLOR="0;32"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:rocky:rocky:9::baseos"
HOME_URL="https://rockylinux.org/"
BUG_REPORT_URL="https://bugs.rockylinux.org/"
SUPPORT_END="2032-05-31"
ROCKY_SUPPORT_PRODUCT="Rocky-Linux-9"
ROCKY_SUPPORT_PRODUCT_VERSION="9.4"
REDHAT_SUPPORT_PRODUCT="Rocky Linux"
REDHAT_SUPPORT_PRODUCT_VERSION="9.4"
`

export const ROCKY_10 = `NAME="Rocky Linux"
VERSION="10.0 (Red Quartz)"
ID="rocky"
ID_LIKE="rhel centos fedora"
VERSION_ID="10.0"
PLATFORM_ID="platform:el10"
PRETTY_NAME="Rocky Linux 10.0 (Red Quartz)"
ANSI_COLOR="0;32"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:rocky:rocky:10::baseos"
HOME_URL="https://rockylinux.org/"
BUG_REPORT_URL="https://bugs.rockylinux.org/"
SUPPORT_END="2035-05-31"
ROCKY_SUPPORT_PRODUCT="Rocky-Linux-10"
ROCKY_SUPPORT_PRODUCT_VERSION="10.0"
REDHAT_SUPPORT_PRODUCT="Rocky Linux"
REDHAT_SUPPORT_PRODUCT_VERSION="10.0"
`

export const CENTOS_LINUX_7 = `NAME="CentOS Linux"
VERSION="7 (Core)"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="7"
PRETTY_NAME="CentOS Linux 7 (Core)"
ANSI_COLOR="0;31"
CPE_NAME="cpe:/o:centos:centos:7"
HOME_URL="https://www.centos.org/"
BUG_REPORT_URL="https://bugs.centos.org/"

CENTOS_MANTISBT_PROJECT="CentOS-7"
CENTOS_MANTISBT_PROJECT_VERSION="7"
REDHAT_SUPPORT_PRODUCT="centos"
REDHAT_SUPPORT_PRODUCT_VERSION="7"
`

export const CENTOS_STREAM_8 = `NAME="CentOS Stream"
VERSION="8"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="8"
PLATFORM_ID="platform:el8"
PRETTY_NAME="CentOS Stream 8"
ANSI_COLOR="0;31"
CPE_NAME="cpe:/o:centos:centos:8"
HOME_URL="https://centos.org/"
BUG_REPORT_URL="https://bugzilla.redhat.com/"
REDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux 8"
REDHAT_SUPPORT_PRODUCT_VERSION="CentOS Stream"
`

export const ALMA_8 = `NAME="AlmaLinux"
VERSION="8.10 (Cerulean Leopard)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="8.10"
PLATFORM_ID="platform:el8"
PRETTY_NAME="AlmaLinux 8.10 (Cerulean Leopard)"
ANSI_COLOR="0;34"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:almalinux:almalinux:8::baseos"
HOME_URL="https://almalinux.org/"
`

export const RHEL_9 = `NAME="Red Hat Enterprise Linux"
VERSION="9.4 (Plow)"
ID="rhel"
ID_LIKE="fedora"
VERSION_ID="9.4"
PLATFORM_ID="platform:el9"
PRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"
ANSI_COLOR="0;31"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:redhat:enterprise_linux:9::baseos"
HOME_URL="https://www.redhat.com/"
`

export const DEBIAN_12 = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"
`

export const UBUNTU_2004 = `NAME="Ubuntu"
VERSION="20.04.6 LTS (Focal Fossa)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 20.04.6 LTS"
VERSION_ID="20.04"
HOME_URL="https://www.ubuntu.com/"
VERSION_CODENAME=focal
UBUNTU_CODENAME=focal
`

export const FEDORA_40 = `NAME="Fedora Linux"
VERSION="40 (Server Edition)"
ID=fedora
VERSION_ID=40
VERSION_CODENAME=""
PLATFORM_ID="platform:f40"
PRETTY_NAME="Fedora Linux 40 (Server Edition)"
ANSI_COLOR="0;38;2;60;110;180"
LOGO=fedora-logo-icon
CPE_NAME="cpe:/o:fedoraproject:fedora:40"
HOME_URL="https://fedoraproject.org/"
VARIANT="Server Edition"
VARIANT_ID=server
`

export const MINT_21 = `NAME="Linux Mint"
VERSION="21.3 (Virginia)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 21.3"
VERSION_ID="21.3"
HOME_URL="https://www.linuxmint.com/"
VERSION_CODENAME=virginia
UBUNTU_CODENAME=jammy
`

export const SUPPORTED_FIXTURES = {
  'ubuntu 22.04': UBUNTU_2204,
  'ubuntu 24.04': UBUNTU_2404,
  'centos stream 9': CENTOS_STREAM_9,
  'centos stream 10': CENTOS_STREAM_10,
  'almalinux 9': ALMA_9,
  'almalinux 10': ALMA_10,
  'rocky 9': ROCKY_9,
  'rocky 10': ROCKY_10,
} as const

export const UNSUPPORTED_FIXTURES = {
  'centos linux 7': CENTOS_LINUX_7,
  'centos stream 8': CENTOS_STREAM_8,
  'almalinux 8': ALMA_8,
  'rhel 9': RHEL_9,
  'debian 12': DEBIAN_12,
  'ubuntu 20.04': UBUNTU_2004,
  'fedora 40': FEDORA_40,
  'linux mint 21': MINT_21,
} as const
