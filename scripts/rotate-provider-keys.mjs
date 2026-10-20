import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../src/db.js";
import ProviderConfig from "../src/providerConfig.js";
import { decryptSecret, encryptSecret, secretNeedsRotation } from "../src/encryption.js";

const apply = process.argv.includes("--apply");

async function main() {
  await connectToDatabase();
  const configs = await ProviderConfig.find({ encryptedApiKey: { $exists: true, $ne: "" } })
    .select("_id userId provider configId +encryptedApiKey")
    .lean();
  let pending = 0;
  let migrated = 0;
  let failed = 0;
  for (const config of configs) {
    if (!secretNeedsRotation(config.encryptedApiKey)) continue;
    pending += 1;
    if (!apply) continue;
    try {
      const plaintext = decryptSecret(config.encryptedApiKey);
      const encryptedApiKey = encryptSecret(plaintext);
      const result = await ProviderConfig.updateOne(
        { _id: config._id, encryptedApiKey: config.encryptedApiKey },
        { $set: { encryptedApiKey } }
      );
      if (result.modifiedCount === 1) migrated += 1;
    } catch {
      failed += 1;
    }
  }
  console.log(`Provider keys requiring rotation: ${pending}`);
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after backing up the providerconfigs collection.");
  } else {
    console.log(`Rotated: ${migrated}; failed: ${failed}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(`Key rotation failed: ${error?.name || "UnknownError"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
