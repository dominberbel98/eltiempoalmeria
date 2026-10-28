import { Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Cloudy, Haze, Moon, Sun } from "lucide-react";
import type { Cielo } from "../lib/tiempo";

type Props = { cielo: Cielo; noche?: boolean; size?: number; titulo?: string };

export default function IconoCielo({ cielo, noche = false, size = 26, titulo }: Props) {
  const Icono =
    cielo === "despejado" ? (noche ? Moon : Sun)
    : cielo === "poco-nuboso" ? (noche ? CloudMoon : CloudSun)
    : cielo === "nuboso" ? Cloud
    : cielo === "cubierto" ? Cloudy
    : cielo === "niebla" ? CloudFog
    : cielo === "lluvia" ? CloudRain
    : cielo === "nieve" ? CloudSnow
    : cielo === "tormenta" ? CloudLightning
    : Haze;
  const soleado = !noche && (cielo === "despejado" || cielo === "poco-nuboso");
  return (
    <Icono
      size={size}
      strokeWidth={1.6}
      className={soleado ? "sun-icon" : "cloud-icon"}
      aria-hidden={titulo ? undefined : true}
      aria-label={titulo}
      role={titulo ? "img" : undefined}
    />
  );
}
