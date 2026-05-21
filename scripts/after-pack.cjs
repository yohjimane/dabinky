const { execSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`[after-pack] ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep -s - "${appPath}"`, {
    stdio: "inherit",
  });
};
