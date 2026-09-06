# Not a real package: written by hand for tests/site/pkgbuild.test.mjs,
# with every corner of the syntax the parser has to survive in one
# file. Everything here is legal bash that a real PKGBUILD does
# somewhere; nothing here builds.
pkgname=edge-cases
pkgver=1.2.3
pkgrel=2
epoch=1
pkgdesc="Quotes, commas (and parens) # and a hash that is not a comment"
arch=('any')
url="https://example.invalid/${pkgname}"
license=('MIT')
_series=${pkgver%.*}
_under=${pkgver//./_}
_stem=${pkgname#edge-}
depends=(
  'bash'          # the shell, obviously
  # a whole line of comment inside the array
  "python>=3.11"
)
depends+=('curl')
makedepends=('git')
install="${pkgname}.install"
changelog=ChangeLog
source=("${pkgname}-${pkgver}.tar.gz::https://example.invalid/${_series}/${_under}.tar.gz"
        "fix-${_stem}.patch"
        'git+https://example.invalid/tool.git#tag=v1.2'
        "https://example.invalid/${_series}/extra.tar.gz"{,.asc})
sha256sums=('SKIP'
            '3f786850e387550fdab836ed7e6dc881de23001b73aba05ab9d3f2f4de6b4a2f'
            'SKIP'
            '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'
            'SKIP')
noextract=("${pkgname}-${pkgver}.tar.gz")

build() {
pkgver=999
  depends=('never-seen')
  cd "${srcdir}/${pkgname}-${pkgver}"
  make
}

package_edge-cases() {
  install -Dm644 README "${pkgdir}/usr/share/doc/${pkgname}/README"
}
