import { createForgeClient, createForgeSessionClient } from "@forge/sdk";
import { createRoot } from "react-dom/client";

import { ForgeApp } from "./app.js";
import { OperatorSession } from "./session.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error(
    "Forge UI could not mount: no #root element in the document.",
  );
}

/**
 * Same origin, always.
 *
 * The API is reached at a relative path: the dev server proxies `/v1` and a
 * deployment puts both behind one origin. That is what lets the session cookie
 * be `SameSite=Strict` and lets the browser send it without any cross-origin
 * credential sharing — and it is why nothing here holds a token. There is no
 * build-time value to inline, so the bundle ships no credential at all.
 */
const BASE_URL = "";

const sessions = createForgeSessionClient({ baseUrl: BASE_URL });

createRoot(rootElement).render(
  <OperatorSession sessions={sessions}>
    {(session) => (
      <ForgeApp
        client={createForgeClient({
          baseUrl: BASE_URL,
          csrfToken: session.csrfToken,
        })}
        dependencies={[
          { name: "api", status: "healthy" },
          { name: "worker", status: "healthy" },
          {
            name: "queue",
            status: "unavailable",
            detail: "Awaiting local Redis.",
          },
        ]}
      />
    )}
  </OperatorSession>,
);
