export function getRandomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

export function generateIpAddress(): string {
  return `192.168.1.${Math.floor(Math.random() * 254) + 1}`;
}
