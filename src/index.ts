export async function main(): Promise<void> {
  console.log('[openbridge] starting...');
}

main().catch((err) => {
  console.error('[openbridge] fatal error:', err);
  process.exit(1);
});
