import assert from "node:assert/strict";
import { test } from "node:test";
import { voicePresets } from "../src/lib/voicePresets";

test("narration styles map to the existing male, female, and youthful TTS voices", () => {
  assert.equal(voicePresets.male.voice, "alloy");
  assert.equal(voicePresets.female.voice, "nova");
  assert.equal(voicePresets.child.voice, "shimmer");
  assert.match(voicePresets.child.instructions, /fictional and age-appropriate/);
});