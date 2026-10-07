<script lang="ts">
  import { avatarColors, initial } from '../avatar'

  let { id, name }: { id: string; name: string } = $props()
  const c = $derived(avatarColors(id))
</script>

<span class="avatar" style:background={c.bg} style:color={c.fg} aria-hidden="true">{initial(name)}</span>
