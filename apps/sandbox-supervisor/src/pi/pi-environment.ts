/**
 * Pi's tools run with whatever environment Pi has, and the model can read
 * all of it, so Pi gets an environment built from an allowlist rather than a
 * copy of the supervisor's. The supervisor's control-plane token is left out.
 *
 * That keeps the token out of anything Pi prints or sends to the model by
 * accident. Whether it also keeps it from a determined agent depends on the
 * user Pi runs as (see src/agent-process). In the sandbox image Pi runs as a
 * user of its own, and Linux shows a process's environment only to the
 * process's own user. Run as the supervisor's user, as on a developer's
 * machine, a tool can read the token from `/proc/<supervisor pid>/environ`;
 * deleting it from `process.env` would not help, because Linux reports the
 * environment the process started with.
 *
 * The variables that name the user (`HOME`, `USER`, `LOGNAME`, `SHELL`) are
 * copied here and then set by the launcher to the user Pi actually runs as.
 */

/** What ordinary command-line tools expect to find. */
const basicVariableNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  // Sandboxes behind an egress proxy need these to reach the model provider.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The API key variables Pi reads for each provider.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
 *
 * Ambient cloud credentials (`AWS_*`, `GOOGLE_*`) are left out on purpose:
 * Pi would pick them up silently, and they usually grant far more than model
 * access.
 */
const providerCredentialVariableNames = [
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

/** Pi's own settings, such as `PI_OFFLINE`. */
const piSettingPrefix = "PI_";

export function buildPiEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  agentDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (value !== undefined && isPassedToPi(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    // Pi keeps credentials, settings and custom models here, under the
    // supervisor's state directory rather than the user's home.
    PI_CODING_AGENT_DIR: agentDirectory,
    // No update checks or install telemetry from inside a sandbox.
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

function isPassedToPi(variableName: string): boolean {
  return (
    basicVariableNames.includes(variableName) ||
    providerCredentialVariableNames.includes(variableName) ||
    variableName.startsWith(piSettingPrefix)
  );
}
