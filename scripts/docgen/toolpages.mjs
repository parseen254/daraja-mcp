/**
 * Turn the extracted tool registry into markdown pages.
 *
 * These pages are generated rather than written, so the reference always
 * matches the tools the server actually registers.
 */

/** Tools whose job is to move or read money, versus configure and inspect. */
const CONTROL = new Set([
  'c2b_register_urls',
  'pull_register',
  'list_callbacks',
  'get_callback',
  'server_health',
  'check_sim_swap',
  'check_age_on_network',
  'validate_identity',
  'query_org_info',
  'stk_query',
  'transaction_status',
  'account_balance',
  'pull_transactions',
]);

function pillsFor(tool) {
  const pills = [CONTROL.has(tool.name) ? 'control' : 'money'];
  if (tool.waits) pills.push('waits for callback');
  if (tool.gated) pills.push('gated in production');
  return pills;
}

function paramTable(tool) {
  if (!tool.parameters.length) return '_No parameters._';

  const rows = tool.parameters.map((p) => {
    const req = p.optional ? '' : ' **required**';
    const def = p.default !== undefined ? ` Defaults to \`${JSON.stringify(p.default)}\`.` : '';
    const desc = p.description || '';
    // Enum types contain pipes, which would otherwise be read as new table
    // cells and scatter the type across columns.
    const type = p.type.replace(/\|/g, '\\|');
    return `| \`${p.name}\`${req} | \`${type}\` | ${desc}${def} |`;
  });

  return ['| Parameter | Type | Notes |', '|---|---|---|', ...rows].join('\n');
}

function toolMarkdown(tool) {
  const pills = pillsFor(tool)
    .map((p) => `\`${p}\``)
    .join(' ');

  // h2, so a group page runs h1 then h2 without skipping a level.
  const parts = [`## ${tool.name}`, '', pills, '', tool.description, '', paramTable(tool)];

  if (tool.gated) {
    parts.push(
      '',
      '> **Warning** This tool moves money outward and is disabled in production ' +
        'unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a ' +
        'phone for this one, so whatever calls it needs its own authorisation step.',
    );
  }

  return parts.join('\n');
}

export function toolPages(tools) {
  const pages = {};

  // The index: what each group is for, and how to find a tool by task.
  pages.tools = {
    description: `All ${tools.total} tools, grouped by what they do.`,
    markdown: [
      '# All tools',
      '',
      `${tools.total} tools covering the Daraja 3.0 product surface. Every one runs ` +
        'against the simulator with no Safaricom account, so you can try any of them ' +
        'before deciding whether the shape fits.',
      '',
      '## Find one by task',
      '',
      '| I want to | Use |',
      '|---|---|',
      '| Charge a customer and know whether it worked | `stk_push_and_wait` |',
      '| Charge a customer without waiting | `stk_push` |',
      '| Set up a recurring collection | `ratiba_create_and_wait` |',
      '| Pay someone out | `b2c_payment_and_wait` |',
      '| Pay another business | `b2b_payment` |',
      '| Check whether a past payment succeeded | `transaction_status` |',
      '| See what a callback actually contained | `get_callback` |',
      '| Check a number for SIM-swap fraud before paying it | `check_sim_swap` |',
      '| Confirm which business owns a shortcode | `query_org_info` |',
      '| Work out why nothing is happening | `server_health` |',
      '',
      '## Groups',
      '',
      ...tools.groups.flatMap((g) => [
        `### ${g.title}`,
        '',
        g.blurb,
        '',
        g.entries.map((t) => `\`${t.name}\``).join(' · '),
        '',
        // Keep the title as written: lowercasing turns "C2B" into "c2b".
        `[See all ${g.entries.length} in ${g.title}](/daraja-mcp/tools-${g.slug}/)`,
        '',
      ]),
      '## Reading an entry',
      '',
      'Each tool carries a few labels. `money` means it moves or reports money; ' +
        '`control` means it configures or inspects. `waits for callback` means it ' +
        'blocks until Daraja reports the settled outcome, rather than returning an ' +
        'acknowledgement. `gated in production` means it is disabled unless you opt ' +
        'in, because it moves money outward with no human approving anything.',
      '',
      'Every tool response also states the environment it ran against, so neither ' +
        'you nor the model has to guess whether real money moved.',
    ].join('\n'),
  };

  for (const group of tools.groups) {
    pages[`tools-${group.slug}`] = {
      description: `${group.title}: ${group.entries.length} tools.`,
      markdown: [
        `# ${group.title}`,
        '',
        group.blurb,
        '',
        ...group.entries.map((t) => `${toolMarkdown(t)}\n`),
      ].join('\n'),
    };
  }

  return pages;
}
