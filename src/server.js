import app from "./app.js";
import { env } from "./config/env.js";
import { verifyPrismaSchema } from "./utils/schemaCheck.js";

await verifyPrismaSchema();

app.listen(env.port, () => {
  console.log(`Server ${env.port}-portda ishlayapti`);
});
