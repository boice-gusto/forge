import { createForgeClient } from "@forge/sdk";
import { renderToStaticMarkup } from "react-dom/server";

import { ForgeApp } from "./app.js";

// The first render issues no request, so the client only has to exist.
renderToStaticMarkup(
  <ForgeApp
    client={createForgeClient({ baseUrl: "" })}
    dependencies={[{ name: "api", status: "healthy" }]}
  />,
);
