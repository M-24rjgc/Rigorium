import React from "react";
import { Box, Text } from "ink";
import { rigoriumDarkBlueTheme } from "./theme.js";

export function RigoriumLogo({ tagline }: { tagline?: string } = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color={rigoriumDarkBlueTheme.brand} bold>
        RIGORIUM
      </Text>
      {tagline ? (
        <Box marginTop={1}>
          <Text color={rigoriumDarkBlueTheme.brandAccent} bold>
            {">  "}
          </Text>
          <Text color={rigoriumDarkBlueTheme.subtle}>{tagline}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function CondensedLogo(): React.ReactNode {
  return (
    <Text>
      <Text color={rigoriumDarkBlueTheme.brand} bold>
        Rigorium
      </Text>
      <Text color={rigoriumDarkBlueTheme.brandAccent}> &gt;</Text>
    </Text>
  );
}
