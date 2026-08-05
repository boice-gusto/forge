import { createForgeClient } from "@forge/sdk";
import { renderToStaticMarkup } from "react-dom/server";

import { ForgeApp } from "./app.js";

// The first render issues no request, so the client only has to exist.
renderToStaticMarkup(
  <ForgeApp
    client={createForgeClient({ baseUrl: "http://127.0.0.1:3100", token: "" })}
    dependencies={[{ name: "api", status: "healthy" }]}
  />,
);
