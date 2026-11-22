/** Host-rendered report example. No code runs until the host explicitly activates this artifact. */
export default (sdk) => ({
  setup(env) {
    const reportSchema = sdk.z.strictObject({
      schemaVersion: sdk.z.literal(1),
      score: sdk.z.number().int().min(0).max(100),
      summary: sdk.z.string().min(1).max(2000),
      checks: sdk.z
        .array(
          sdk.z.strictObject({
            name: sdk.z.string().min(1).max(120),
            status: sdk.z.enum(['pass', 'warn', 'fail']),
          }),
        )
        .max(100),
    });
    const event = env.defineEvent('report', { schema: reportSchema });
    const writer = env.use(sdk.sessionStoreRef);
    env.contribute(sdk.toolsExtensionPoint, (api) => {
      api.addTool({
        name: 'quality_report',
        description: '记录已收集证据的质量报告。此工具保存报告，不运行测试或检查。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'integer', const: 1 },
            score: { type: 'integer', minimum: 0, maximum: 100 },
            summary: { type: 'string', minLength: 1, maxLength: 2000 },
            checks: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 120 },
                  status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
                },
                required: ['name', 'status'],
              },
            },
          },
          required: ['schemaVersion', 'score', 'summary', 'checks'],
        },
        inputSchema: reportSchema,
        async execute(input, context) {
          if (context.sessionId === undefined) throw new Error('质量报告需要当前 Session');
          await (await writer.get()).append(context.sessionId, [event.create(input)]);
          return `已记录质量报告：${input.score}/100，${input.checks.length} 项检查。`;
        },
      });
    });
    env.contribute(sdk.commandsExtensionPoint, (api) => {
      api.addCommand({
        name: 'quality-report',
        title: '准备质量检查',
        description: '按范围收集真实证据，再记录质量报告。',
        prompt:
          '请根据以下选项检查当前项目质量。先核对实际可用工具并收集证据；执行命令遵循当前工作区和审批。不要把未运行的测试标为通过。有足够证据时调用 quality_report 记录分数、总结与检查状态。\n\n$ARGUMENTS',
      });
    });
    env.contribute(sdk.panelsExtensionPoint, (api) => {
      api.addPanel({
        schemaVersion: 1,
        id: 'report',
        title: '质量报告',
        description: '查看当前会话最近的质量报告，准备下一轮检查。',
        icon: 'checklist',
        placement: 'right',
        sources: [{ id: 'report', eventType: 'quality-report/report', payloadVersion: 1 }],
        blocks: [
          { id: 'heading', type: 'heading', text: '最近的质量报告' },
          {
            id: 'score',
            type: 'metric',
            label: '评分',
            unit: '/100',
            value: { binding: { source: 'report', path: ['score'] } },
          },
          {
            id: 'summary',
            type: 'text',
            value: { binding: { source: 'report', path: ['summary'] } },
          },
          {
            id: 'checks',
            type: 'table',
            rows: { source: 'report', path: ['checks'] },
            columns: [
              { id: 'name', title: '检查', path: ['name'] },
              { id: 'status', title: '状态', path: ['status'] },
            ],
          },
          {
            id: 'prepare',
            type: 'form',
            fields: [
              {
                id: 'target',
                type: 'text',
                label: '检查范围',
                required: true,
                default: '当前修改',
              },
              { id: 'include-tests', type: 'boolean', label: '包含相关测试', default: true },
            ],
            submit: { type: 'prepare-command', command: 'quality-report', label: '准备到对话' },
          },
        ],
      });
    });
  },
});
