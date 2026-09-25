/**
 * The link preview card, drawn from the same query the page reads.
 *
 * Share a run and the card shows that run: its roster in their marble colours,
 * its seed, its track. Satori draws it, so this is flexbox and plain colours
 * only, nothing the board renderer does.
 */

import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { getMessages } from "../../lib/i18n";
import { css, marbleColor } from "../../lib/palette";
import { isLatinText, readSharedRun } from "../../lib/share";
import BrandMark from "../../components/BrandMark";

export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 630;

/** Runners listed by name; past this the rest become a count. */
const SHOWN = 8;

const FONT_CDN = "https://cdn.jsdelivr.net/fontsource/fonts";

async function loadFont(
  slug: string,
  subset: string,
  weight: number,
): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(
      `${FONT_CDN}/${slug}@latest/${subset}-${weight}-normal.ttf`,
    );
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const run = readSharedRun(params);
  const t = getMessages(run.locale);

  const shown = run.names.slice(0, SHOWN);
  const rest = run.names.length - shown.length;

  // The Korean face is 2.4 MB, so it is only pulled in when a name needs it.
  const needsCjk =
    run.locale === "ko" || run.names.some((name) => !isLatinText(name));
  const [latin, cjk] = await Promise.all([
    loadFont("poppins", "latin", 700),
    needsCjk ? loadFont("noto-sans-kr", "korean", 700) : Promise.resolve(null),
  ]);

  const fonts = [
    latin && {
      name: "Poppins",
      data: latin,
      weight: 700 as const,
      style: "normal" as const,
    },
    cjk && {
      name: "Noto Sans KR",
      data: cjk,
      weight: 700 as const,
      style: "normal" as const,
    },
  ].filter((font): font is NonNullable<typeof font> => !!font);

  const track = t.settings.tracks[run.track];
  const subtitle = run.names.length
    ? `${t.run.runners(run.names.length)} · ${track.label} · ${run.seed}`
    : `${track.label} · ${run.seed}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#0b0b0d",
        color: "#ececee",
        fontFamily: "Poppins, Noto Sans KR",
        padding: 0,
      }}
    >
      {/* The bolt spectrum, the same signature the header wears. */}
      <div
        style={{
          height: 10,
          width: "100%",
          background:
            "linear-gradient(90deg, #0090d8, #00b8c4, #00e0a0, #8ed44a, #ffc233, #fb832e, #f0492f)",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "56px 64px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <BrandMark size={64} />
          <div style={{ display: "flex", fontSize: 58, letterSpacing: -1.5 }}>
            Thor Marble Race
          </div>
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 14,
            fontSize: 26,
            color: "#8e929a",
          }}
        >
          {subtitle}
        </div>

        {/* The roster, each runner in the colour their marble will be. A
              single wrapped line ignores alignContent, so the centring is done
              by the row that holds it. */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            paddingTop: 24,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {shown.map((name, index) => (
              <div
                key={`${name}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 24px 12px 16px",
                  borderRadius: 999,
                  background: "#17171a",
                  border: `1px solid ${css(marbleColor(index), 0.45)}`,
                  fontSize: 30,
                  maxWidth: 520,
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 999,
                    display: "flex",
                    background: `linear-gradient(135deg, ${css(marbleColor(index))}, ${css(marbleColor(index), 0.55)})`,
                  }}
                />
                <div style={{ display: "flex" }}>{name}</div>
              </div>
            ))}

            {rest > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "12px 24px",
                  borderRadius: 999,
                  border: "1px solid #3b3b42",
                  fontSize: 30,
                  color: "#8e929a",
                }}
              >
                +{rest}
              </div>
            )}

            {!run.names.length && (
              <div style={{ display: "flex", fontSize: 32, color: "#8e929a" }}>
                {t.roster.empty}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 24,
            color: "#8e929a",
          }}
        >
          <div style={{ display: "flex" }}>{track.hint}</div>
          <div style={{ display: "flex", color: "#3b3b42" }}>/</div>
          <div style={{ display: "flex" }}>@thorvg/webcanvas</div>
        </div>
      </div>
    </div>,
    { width: WIDTH, height: HEIGHT, fonts: fonts.length ? fonts : undefined },
  );
}
