import { createApp } from "./app";
import { depsFromEnv, portFromEnv } from "./config";

const app = createApp(depsFromEnv(process.env));

export default { port: portFromEnv(process.env), fetch: app.fetch };
