<script lang="ts">
  let {
    reason,
    onsave,
    oncancel,
  }: {
    /** What the name is needed for, e.g. "before you chat". */
    reason: string
    onsave: (name: string) => void
    oncancel: () => void
  } = $props()

  let name = $state('')
  let dialog: HTMLDialogElement | undefined = $state()
  const valid = $derived(name.trim().length > 0)

  $effect(() => {
    dialog?.showModal()
  })

  function save(e: SubmitEvent) {
    e.preventDefault()
    if (!valid) return
    dialog?.close()
    onsave(name.trim().slice(0, 32))
  }

  function cancel() {
    dialog?.close()
    oncancel()
  }
</script>

<dialog bind:this={dialog} data-testid="name-dialog" oncancel={cancel}>
  <form onsubmit={save}>
    <h3>What's your name?</h3>
    <p class="hint">Others in the lobby see it. Pick one {reason}.</p>
    <label>
      Your name
      <!-- svelte-ignore a11y_autofocus -->
      <input data-testid="name-input" maxlength="32" autofocus bind:value={name} />
    </label>
    <div class="dialog-actions">
      <button type="button" onclick={cancel}>Cancel</button>
      <button type="submit" class="primary" data-testid="name-save" disabled={!valid}>Continue</button>
    </div>
  </form>
</dialog>
