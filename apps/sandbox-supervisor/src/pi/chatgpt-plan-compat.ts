/**
 * What Pi is told, in its `models.json`, about OpenAI's models when the
 * thread's OpenAI requests run on its owner's ChatGPT plan, so that it
 * shapes them as OpenAI's "Sign in with ChatGPT" programme takes them.
 *
 * Pi shapes them so by itself only when it sends them to OpenAI's own
 * address with a credential that is not an API key (`isChatGPTSignIn` in
 * pi-ai's `api/openai-responses.js`): it then leaves out
 * `max_output_tokens`, `prompt_cache_retention` and `prompt_cache_options`,
 * and gives the reasoning effort at the top level rather than in
 * `configuration_update` items, which the programme refuses
 * (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
 * Through the model proxy its address is the proxy's, so it would send them
 * all; these flags, which Pi's `models.json` takes for a provider
 * (`compat`), make it send what it sends the programme itself.
 *
 * The model catalogue's test (`chatgpt-plan-requests-match-pinned-agent`)
 * builds every request the pinned Pi sends to OpenAI both ways, and fails
 * unless these flags make them the same byte for byte, so an upgrade of Pi
 * that changes what its own sign-in leaves out is caught. Nothing else may
 * be imported here: that test reads this file from the catalogue's package.
 */
export const chatGptPlanPiCompat = {
  supportsMaxOutputTokens: false,
  supportsLongCacheRetention: false,
  supportsExplicitPromptCacheMode: false,
  supportsMidConvoEffort: false,
} as const;
