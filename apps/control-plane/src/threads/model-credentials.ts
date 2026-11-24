/**
 * TEMPORARY, until each user brings their own model access (Milestone 4).
 * Until then the plan allows one developer-supplied key, so the control
 * plane forwards the model provider keys in its own environment to every
 * thread's sandbox. Every thread can therefore spend on that key, and
 * everything in a sandbox, the agent included, can read it.
 *
 * The names are the supervisor's allowlist of provider credentials, which
 * it passes on to Pi (`providerCredentialVariableNames` in
 * apps/sandbox-supervisor/src/pi/pi-environment.ts); keep the two the same.
 * Ambient cloud credentials (`AWS_*`, `GOOGLE_*`) are deliberately absent.
 */
export const forwardedModelCredentialNames = [
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
];

/** The allowlisted variables that are set. Values are secrets: never log them. */
export function readModelCredentials(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const credentials: Record<string, string> = {};
  for (const name of forwardedModelCredentialNames) {
    const value = environment[name];
    if (value !== undefined && value !== "") {
      credentials[name] = value;
    }
  }
  return credentials;
}
