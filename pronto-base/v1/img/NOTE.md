# Packaged assets

Drop `havas-pronto-wide.png` (from https://havaspronto.com/v2/build/images/logos/Havas-pronto-wide.png) into this folder and the nav will serve the logo from the package automatically — it tries `img/havas-pronto-wide.png` first, then the live havaspronto.com URL, then a text logo.

(The sandboxed build environment can't download binaries from havaspronto.com, so copy it in manually or via CI when setting up the package's own host.)
