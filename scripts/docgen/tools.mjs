/**
 * Extract the tool reference from the running server.
 *
 * Reading the live registry rather than a hand-written list means the docs
 * cannot claim a tool that does not exist, or miss one that does. There is no
 * CI here to catch that drift, so the only durable fix is to remove the
 * possibility.
 */

/** Which group a tool belongs to, and in what order groups are presented. */
export const GROUPS = [
  {
    slug: 'payments',
    title: 'Payments',
    blurb:
      'Collecting money from a customer. These are the flows where the customer ' +
      'approves a prompt on their own phone, so a person is always in the loop.',
    tools: [
      'stk_push',
      'stk_push_and_wait',
      'stk_query',
      'ratiba_create',
      'ratiba_create_and_wait',
      'generate_qr',
    ],
  },
  {
    slug: 'disbursement',
    title: 'Disbursement and treasury',
    blurb:
      'Moving money out, and the treasury operations around it. Nothing here ' +
      'asks a human to approve anything, which is why most of it is disabled ' +
      'in production until you opt in.',
    tools: [
      'b2c_payment',
      'b2c_payment_and_wait',
      'b2b_payment',
      'tax_remittance',
      'business_to_pochi',
      'account_balance',
      'transaction_status',
      'reversal',
    ],
  },
  {
    slug: 'identity',
    title: 'Identity and fraud',
    blurb:
      'New in Daraja 3.0. Cheap checks worth running before you send money to ' +
      'a number you have not paid before.',
    tools: ['check_sim_swap', 'check_age_on_network', 'validate_identity', 'query_org_info'],
  },
  {
    slug: 'c2b',
    title: 'C2B and diagnostics',
    blurb:
      'Receiving payments customers start themselves, and the tools for seeing ' +
      'what actually arrived.',
    tools: [
      'c2b_register_urls',
      'c2b_simulate',
      'pull_register',
      'pull_transactions',
      'list_callbacks',
      'get_callback',
      'server_health',
    ],
  },
];

/** Tools that move money outward and are gated in production. */
const GATED = new Set([
  'b2c_payment',
  'b2c_payment_and_wait',
  'b2b_payment',
  'tax_remittance',
  'business_to_pochi',
  'reversal',
  'ratiba_create',
  'ratiba_create_and_wait',
]);

/** Tools that block on a callback and return a settled outcome. */
const WAITING = new Set(['stk_push_and_wait', 'b2c_payment_and_wait', 'ratiba_create_and_wait']);

/** Read a Zod type down to something describable. */
function describeZod(schema) {
  let node = schema;
  let optional = false;
  let defaultValue;

  // Unwrap optional and default wrappers to reach the real type.
  for (let i = 0; i < 10; i++) {
    const def = node?._def;
    if (!def) break;
    const name = def.typeName;

    if (name === 'ZodOptional') {
      optional = true;
      node = def.innerType;
      continue;
    }
    if (name === 'ZodDefault') {
      optional = true;
      try {
        defaultValue = def.defaultValue();
      } catch {
        // A thrown default is not worth documenting.
      }
      node = def.innerType;
      continue;
    }
    break;
  }

  const def = node?._def ?? {};
  const typeName = def.typeName ?? 'unknown';

  let type;
  switch (typeName) {
    case 'ZodString':
      type = 'string';
      break;
    case 'ZodNumber':
      type = 'number';
      break;
    case 'ZodBoolean':
      type = 'boolean';
      break;
    case 'ZodEnum':
      type = (def.values ?? []).map((v) => `"${v}"`).join(' | ');
      break;
    default:
      type = typeName.replace(/^Zod/, '').toLowerCase();
  }

  return {
    type,
    optional,
    default: defaultValue,
    description: node?.description ?? schema?.description ?? '',
  };
}

/** Pull the parameter list out of a registered tool's input schema. */
function parametersOf(tool) {
  const schema = tool.inputSchema;
  const shape = schema?._def?.shape?.() ?? schema?.shape ?? null;
  if (!shape) return [];

  return Object.entries(shape).map(([name, value]) => ({
    name,
    ...describeZod(value),
  }));
}

/**
 * Start the server in simulator mode and read every registered tool.
 * The receiver is disabled so this does not need a free port.
 */
export async function extractTools() {
  const { createServer } = await import('../../dist/index.js');

  const { server, shutdown } = await createServer({
    config: {
      mode: 'simulator',
      baseUrl: 'http://127.0.0.1:0',
      consumerKey: 'docs',
      consumerSecret: 'docs',
      allowPayouts: true,
      callback: {
        port: 0,
        allowedCidrs: [],
        storeDir: '/tmp/daraja-docs',
        trustProxy: false,
      },
    },
    disableReceiver: true,
  });

  const registry = server._registeredTools ?? {};
  const tools = Object.entries(registry).map(([name, tool]) => ({
    name,
    description: tool.description ?? '',
    parameters: parametersOf(tool),
    gated: GATED.has(name),
    waits: WAITING.has(name),
  }));

  await shutdown();

  // Fail loudly if a tool exists that no group claims, or a group names one
  // that does not exist. Either means the docs are about to lie.
  const known = new Set(tools.map((t) => t.name));
  const grouped = new Set(GROUPS.flatMap((g) => g.tools));

  const ungrouped = [...known].filter((n) => !grouped.has(n));
  const phantom = [...grouped].filter((n) => !known.has(n));

  if (ungrouped.length || phantom.length) {
    const problems = [];
    if (ungrouped.length) problems.push(`not in any group: ${ungrouped.join(', ')}`);
    if (phantom.length) problems.push(`grouped but not registered: ${phantom.join(', ')}`);
    throw new Error(`Tool grouping is out of sync with the server (${problems.join('; ')})`);
  }

  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    total: tools.length,
    groups: GROUPS.map((g) => ({ ...g, entries: g.tools.map((n) => byName.get(n)) })),
  };
}
