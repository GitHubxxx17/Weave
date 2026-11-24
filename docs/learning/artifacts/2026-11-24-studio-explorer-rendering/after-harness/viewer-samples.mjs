/** Every matrix cell owns its synthetic fixture and browser, even after failure. */
export function* viewerCases(options) {
  for (const bytes of options.sizes)
    for (const encoding of options.encodings)
      for (const lineShape of options.lineShapes)
        for (let repeat = 0; repeat < options.repeats; repeat++)
          yield { bytes, encoding, lineShape, repeat };
}

export async function* viewerSamples(options, ports) {
  for (const scenario of viewerCases(options)) {
    let fixture;
    let browserAttempted = false;
    let observation;
    const cleanupFailures = [];
    try {
      fixture = await ports.startFixture(scenario);
      browserAttempted = true;
      await ports.openBrowser(fixture, scenario);
      const result = await ports.probe(fixture, scenario);
      observation = {
        ...scenario,
        fixtureHash: fixture.tree?.hash,
        status: result.failures?.length ? 'failed' : 'passed',
        result,
      };
    } catch (error) {
      observation = {
        ...scenario,
        fixtureHash: fixture?.tree?.hash,
        status: 'failed',
        failure: { message: error.message, stack: error.stack },
      };
    } finally {
      if (browserAttempted)
        try {
          await ports.closeBrowser(fixture, scenario);
        } catch (error) {
          cleanupFailures.push({ owner: 'browser', message: error.message });
        }
      if (fixture)
        try {
          await fixture.close();
        } catch (error) {
          cleanupFailures.push({ owner: 'fixture', message: error.message });
        }
    }
    if (cleanupFailures.length) {
      observation.status = 'failed';
      observation.cleanupFailures = cleanupFailures;
    }
    yield observation;
    if (cleanupFailures.some((failure) => failure.owner === 'browser'))
      throw Error('Browser cleanup failed; stop to avoid contaminating later samples');
  }
}
