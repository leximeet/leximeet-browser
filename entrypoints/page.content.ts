import { mountReader } from "../page/reader.ts";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  noScriptStartedPostMessage: true,
  runAt: "document_idle",
  allFrames: false,
  main: mountReader,
});
