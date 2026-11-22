# Verification checklist

1. Define the observable result before choosing the command. Include failure or
   cancellation behavior when the change affects lifecycle or persistence.
2. Run the smallest meaningful regression first. Ensure it reaches the real
   boundary and asserts the user-visible behavior or durable facts.
3. Build upstream packages when tests consume emitted artifacts. A stale build
   can test yesterday's implementation even if the source appears correct.
4. Run required repository gates after focused checks pass. Inspect every exit
   status and the final test summary, including failures after partial success.
5. For a UI, inspect supported viewports and keyboard interactions. For an API,
   verify actual serialized requests and responses, not only internal objects.
6. After a relevant fix, repeat the affected acceptance flow. Avoid rerunning
   unrelated expensive checks without a changed input or unresolved concern.
7. State limitations precisely: scripted provider versus live model, fixture UI
   versus actual Server, local build versus external CI, or an unavailable service.
