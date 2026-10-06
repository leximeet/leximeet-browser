<template>
  <div class="v3-fireworks" aria-hidden="true">
    <i v-for="n in 24" :key="n" :style="{ '--angle': `${n * 15}deg` }" />
  </div>
</template>
