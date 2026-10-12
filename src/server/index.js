import { type, models, agentConfigurationDoc } from '../index.js';
import { execute } from './execute.js?v=0.2.11';
import { testEnvironment } from './test.js';
import { sessionCodec } from '../lib/result.js';
import { configSchema } from '../lib/config.js';
import { discoverAgyModels } from '../lib/models.js';
import { listSkills, syncSkills } from '../lib/skills.js';
export function createServerAdapter() {
  return {type,execute,testEnvironment,models,supportsLocalAgentJwt:true,
    listModels:discoverAgyModels,refreshModels:discoverAgyModels,
    listSkills,syncSkills,requiresMaterializedRuntimeSkills:true,
    agentConfigurationDoc,sessionCodec,
    getConfigSchema:()=>configSchema,
    supportsInstructionsBundle:true,instructionsPathKey:'instructionsFilePath',
    getRuntimeCommandSpec:config=>({command:typeof config.command==='string'?config.command:'agy'}),
    runtimeToolDelivery:'environment',
  };
}
