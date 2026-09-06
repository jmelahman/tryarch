# Not a real package: written by hand for tests/site/pkgbuild.test.mjs.
# A split package's per-package metadata lives in package_*() bodies,
# which are bash and which this parser skips on purpose.
pkgbase=demo
pkgname=(demo demo-docs)
pkgver=2.0
pkgrel=1
arch=('x86_64')
depends=('glibc')
source=("demo-$pkgver-${arch[0]}.tar.gz::https://example.invalid/demo/$pkgver.tar.gz")
sha512sums=('SKIP')

package_demo() {
  depends=('glibc' 'zlib')
  echo demo
}

package_demo-docs() {
  depends=()
  echo docs
}
