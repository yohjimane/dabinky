import React from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./Editor";

const root = document.getElementById("root");
if (!root) throw new Error("no root element");
createRoot(root).render(
  <React.StrictMode>
    <Editor />
  </React.StrictMode>,
);
