// 明确用途的 WAV 测试音，只验证媒体生命周期，不代表有道词音的质量。
export function audioFixture(durationMs = 200) {
  const samples = Math.round(8 * durationMs),
    wave = Buffer.alloc(44 + samples * 2);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wave.writeInt16LE(
      Math.round(Math.sin((i * Math.PI * 2 * 440) / 8000) * 700),
      44 + i * 2,
    );
  return wave;
}
