import type { StreamParser } from "@codemirror/language";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";

// The legacy mode predates proto3: it has no block comments, and `oneof`/`map`/
// `extend` tokenize as plain identifiers. Patch those in, delegate the rest.
export const proto3: StreamParser<{ block: boolean }> = {
  name: "protobuf",
  languageData: protobuf.languageData,
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      if (stream.match(/^.*?\*\//)) state.block = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      if (!stream.match(/^.*?\*\//)) {
        stream.skipToEnd();
        state.block = true;
      }
      return "comment";
    }
    if (stream.match(/^(oneof|map|extend|stream|public|weak|group|true|false|to|max)\b/))
      return "keyword";
    return protobuf.token(stream, state);
  },
};
