/* The pairing screen's camera. The permission hook matters more than the view:
   every path through that screen calls it. */
import { useState } from "react";
import { Text, View } from "react-native";

export function CameraView(props: { style?: unknown }): React.ReactNode {
  return (
    <View style={[{ flex: 1, alignItems: "center", justifyContent: "center" }, props.style as never]}>
      <Text style={{ color: "#6e7681", fontSize: 12 }}>camera (not in this harness)</Text>
    </View>
  );
}

export function useCameraPermissions(): [
  { granted: boolean } | null,
  () => Promise<{ granted: boolean }>,
] {
  const [permission] = useState<{ granted: boolean }>({ granted: true });
  return [permission, async () => ({ granted: true })];
}
