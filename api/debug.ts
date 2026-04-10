import type { IncomingMessage, ServerResponse } from "http";

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  const envKeys = Object.keys(process.env).sort();
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      keys: envKeys,
      truthy: {
        GOOGLECLIENTID: Boolean(process.env.GOOGLECLIENTID),
        GOOGLECLIENTSECRET: Boolean(process.env.GOOGLECLIENTSECRET),
        GOOGLEREFRESHTOKEN: Boolean(process.env.GOOGLEREFRESHTOKEN),
      },
    }),
  );
}
