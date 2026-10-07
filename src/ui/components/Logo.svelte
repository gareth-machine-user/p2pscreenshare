<script lang="ts">
  /** The mark: a screen above three peers. */
  let { size = 30 }: { size?: number } = $props()
</script>

<svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="9" fill="#11141a" stroke="#2c3442" />
  <rect x="8" y="8" width="16" height="11" rx="2.5" stroke="#6aa8ff" stroke-width="2" />
  <circle cx="9" cy="24.5" r="2" fill="#6aa8ff" />
  <circle cx="16" cy="24.5" r="2" fill="#6aa8ff" />
  <circle cx="23" cy="24.5" r="2" fill="#6aa8ff" />
</svg>
