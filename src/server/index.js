import { type, models, agentConfigurationDoc } from '../index.js';
// Paperclip reloads this entry point with a query string; version the changed
// executor too so an already running host does not retain the old ESM module.
import { execute } from './execute.js?v=0.6.0-completion';
import { testEnvironment } from './test.js';
import { sessionCodec } from '../lib/result.js?v=0.6.0-completion';
import { configSchema } from '../lib/config.js?v=0.6.0-completion';
import { discoverAgyModels } from '../lib/models.js';
import { getQuotaWindows } from '../lib/quota.js?v=0.6.0-completion';
import { listSkills, syncSkills } from '../lib/skills.js';
import { resolveAntigravityAuthCacheDir, writeAntigravityAuthCacheEntry, copyBackAntigravityAuth, resolveAntigravityHostAuthPath, decideAntigravityAuthMerge } from '../lib/auth-cache.js';
import { resolveAntigravityAuthPrecedence } from '../lib/auth-precedence.js';
import { runDeviceLogin } from './login-runner.js';
import { evaluateAntigravityCredentialReadiness } from '../lib/credential-readiness.js';

export function createServerAdapter() {
  return {type,execute,testEnvironment,models,supportsLocalAgentJwt:true,
    listModels:discoverAgyModels,refreshModels:discoverAgyModels,getQuotaWindows,
    listSkills,syncSkills,requiresMaterializedRuntimeSkills:true,
    agentConfigurationDoc,sessionCodec,
    getConfigSchema:()=>configSchema,
    supportsInstructionsBundle:true,instructionsPathKey:'instructionsFilePath',
    getRuntimeCommandSpec:config=>({command:typeof config?.command==='string'?config.command:'agy'}),
    runtimeToolDelivery:'environment',
    resolveAuthPrecedence:resolveAntigravityAuthPrecedence,
    runDeviceLogin,
    evaluateCredentialReadiness:evaluateAntigravityCredentialReadiness,
  };
}

export { resolveAntigravityAuthCacheDir, writeAntigravityAuthCacheEntry, copyBackAntigravityAuth, resolveAntigravityHostAuthPath, decideAntigravityAuthMerge } from '../lib/auth-cache.js';
export { resolveAntigravityAuthPrecedence } from '../lib/auth-precedence.js';
export { runDeviceLogin, parseDeviceLoginPrompt } from './login-runner.js';
export { evaluateAntigravityCredentialReadiness } from '../lib/credential-readiness.js';
export { logAntigravityProbeDiagnostic, normalizeAntigravityLoginUrl, buildAntigravityLoginRequiredHint, resolveAdapterTestTargetLabel, buildAdapterTestTargetCheck } from '../lib/probe-diagnostics.js';

