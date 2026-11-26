// Nothing to rebuild (the only runtime dep, `ws`, is pure JS). Kept as a hook so contributors
// get a friendly reminder about the Python sidecar.
if (!process.env.CI && !process.env.ATLAS_QUIET) {
  console.log('\n  Claude OS Agent: remember the Python sidecar →  npm run backend:build   (or ./build.sh)\n');
}
