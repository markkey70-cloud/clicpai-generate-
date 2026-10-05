export const voicePresets = {
  male: {
    voice: "alloy",
    instructions: "Read the supplied script in a natural adult masculine-sounding voice. Speak only the provided words.",
  },
  female: {
    voice: "nova",
    instructions: "Read the supplied script in a natural adult feminine-sounding voice. Speak only the provided words.",
  },
  child: {
    voice: "shimmer",
    instructions: "Read the supplied script in a youthful, childlike, friendly voice. Keep it fictional and age-appropriate; do not imitate a real person. Speak only the provided words.",
  },
} as const;

export type VoiceStyle = keyof typeof voicePresets;