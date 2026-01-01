// components/ReceiptlessQrView.tsx
import React, { useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";

type Props = {
  token: string;
  domain: string;

  size?: number; // default 300
  title?: string;

  // Logo can be remote URL or local require()
  logo?: { uri: string } | number;

  // If not provided, we compute a safe value (<= 18% of size)
  logoSize?: number;

  // Error correction: default M; use Q if you insist on larger logos
  ecc?: "L" | "M" | "Q" | "H";

  // Quiet zone in "modules"; default 8
  quietZone?: number;
};

// Replace Unicode hyphens/dashes and strip zero-width characters.
function normalizeToken(raw: string) {
  let s = String(raw || "").trim();

  // Replace common Unicode hyphens/dashes with ASCII hyphen
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-");

  // Strip zero-width characters
  s = s.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "");

  return s.trim();
}

function buildReceiptUrl(domain: string, token: string) {
  const cleanDomain = domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const cleanToken = normalizeToken(token);
  return `https://${cleanDomain}/r/${encodeURIComponent(cleanToken)}`;
}

function computeSafeLogoSize(qrSize: number) {
  // <= 18% is a good safe default for ECC=M
  return Math.max(32, Math.round(qrSize * 0.18)); // 54 at 300
}

export function ReceiptlessQrView({
  token,
  domain,
  size = 300,
  title = "Scan to save your receipt",
  logo,
  logoSize,
  ecc = "M",
  quietZone = 8,
}: Props) {
  const cleanToken = useMemo(() => normalizeToken(token), [token]);

  const receiptUrl = useMemo(
    () => buildReceiptUrl(domain, cleanToken),
    [domain, cleanToken]
  );

  // If remote logo fails, we retry without it.
  const [logoEnabled, setLogoEnabled] = useState(true);

  const effectiveLogoSize = useMemo(
    () => (logoSize != null ? logoSize : computeSafeLogoSize(size)),
    [logoSize, size]
  );

  const missingToken = !cleanToken || cleanToken.length === 0;

  if (missingToken) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Unable to generate QR</Text>
          <Text style={styles.errorText}>Missing receipt token.</Text>
        </View>
      </View>
    );
  }

  const handleOpen = async () => {
    try {
      const can = await Linking.canOpenURL(receiptUrl);
      if (!can) {
        Alert.alert("Cannot open link", receiptUrl);
        return;
      }
      await Linking.openURL(receiptUrl);
    } catch {
      Alert.alert("Unable to open link", receiptUrl);
    }
  };

  const handleLogoError = () => {
    // Remote logo URIs can fail in-store due to network restrictions.
    // Drop the logo and re-render the QR so scanning still works.
    setLogoEnabled(false);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>

      <View style={styles.qrCard}>
        <QRCode
          value={receiptUrl}
          size={size}
          ecl={ecc}
          quietZone={quietZone}
          logo={logo && logoEnabled ? logo : undefined}
          logoSize={logo && logoEnabled ? effectiveLogoSize : undefined}
          logoBackgroundColor="white"
          // If the lib triggers an error for remote logos, this keeps UX stable.
          onError={handleLogoError}
        />
      </View>

      <Text style={styles.url} numberOfLines={2}>
        {receiptUrl}
      </Text>

      {!logoEnabled && logo ? (
        <Text style={styles.note} numberOfLines={2}>
          Logo unavailable — showing standard QR for reliability.
        </Text>
      ) : null}

      <Pressable style={styles.btn} onPress={handleOpen}>
        <Text style={styles.btnText}>Open receipt link</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F6F7F9",
  },
  title: {
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 14,
    color: "rgba(0,0,0,0.88)",
  },
  qrCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  url: {
    marginTop: 12,
    fontSize: 12,
    color: "rgba(0,0,0,0.55)",
    textAlign: "center",
  },
  note: {
    marginTop: 8,
    fontSize: 12,
    color: "rgba(0,0,0,0.55)",
    textAlign: "center",
  },
  btn: {
    marginTop: 14,
    width: "100%",
    maxWidth: 420,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
  },
  errorBox: {
    width: "100%",
    maxWidth: 420,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(239, 68, 68, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.25)",
  },
  errorTitle: {
    fontWeight: "800",
    marginBottom: 4,
    color: "rgba(0,0,0,0.86)",
  },
  errorText: { color: "rgba(0,0,0,0.72)" },
});
