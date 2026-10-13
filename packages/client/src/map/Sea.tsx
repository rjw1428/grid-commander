export function Sea() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.36, 0]} receiveShadow>
      <planeGeometry args={[400, 400]} />
      <meshStandardMaterial color="#0a1420" roughness={1} metalness={0} />
    </mesh>
  );
}
