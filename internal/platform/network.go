package platform

import (
	"math"
	"sort"
)

const earthRadiusM = 6371000.0

func haversine(a, b LatLon) float64 {
	toRad := math.Pi / 180
	dLat := (b[0] - a[0]) * toRad
	dLon := (b[1] - a[1]) * toRad
	s := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(a[0]*toRad)*math.Cos(b[0]*toRad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusM * math.Asin(math.Sqrt(s))
}

// prepare calcule les distances cumulées du tracé et la position des arrêts.
func (l *Line) prepare(stops map[string]*Stop) {
	l.shapeDist = make([]float64, len(l.Shape))
	for i := 1; i < len(l.Shape); i++ {
		l.shapeDist[i] = l.shapeDist[i-1] + haversine(l.Shape[i-1], l.Shape[i])
	}
	l.stopDist = map[string]float64{}
	for _, sid := range l.StopIDs {
		if s := stops[sid]; s != nil {
			l.stopDist[sid] = l.project(LatLon{s.Lat, s.Lon})
		}
	}
	if l.SpeedKmh <= 0 {
		l.SpeedKmh = 18
	}
	l.StopMinutes = make([]float64, len(l.StopIDs))
	for i, sid := range l.StopIDs {
		l.StopMinutes[i] = math.Round((l.stopDist[sid]/1000/l.SpeedKmh*60+0.4*float64(i))*10) / 10
	}
}

// Length renvoie la longueur du tracé en mètres.
func (l *Line) Length() float64 {
	if len(l.shapeDist) == 0 {
		return 0
	}
	return l.shapeDist[len(l.shapeDist)-1]
}

// project renvoie la distance le long du tracé du point le plus proche.
// Projection plane locale (suffisante à l'échelle d'un corridor urbain).
func (l *Line) project(pt LatLon) float64 {
	best, bestD := 0.0, math.MaxFloat64
	kx := math.Cos(pt[0]*math.Pi/180) * 111320
	ky := 110540.0
	for i := 1; i < len(l.Shape); i++ {
		a, b := l.Shape[i-1], l.Shape[i]
		ax, ay := a[1]*kx, a[0]*ky
		bx, by := b[1]*kx, b[0]*ky
		px, py := pt[1]*kx, pt[0]*ky
		dx, dy := bx-ax, by-ay
		t := 0.0
		if seg := dx*dx + dy*dy; seg > 0 {
			t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/seg))
		}
		cx, cy := ax+t*dx, ay+t*dy
		d := math.Hypot(px-cx, py-cy)
		if d < bestD {
			bestD = d
			best = l.shapeDist[i-1] + t*(l.shapeDist[i]-l.shapeDist[i-1])
		}
	}
	return best
}

// PointAt renvoie la position et le cap à une distance donnée du tracé.
func (l *Line) PointAt(dist float64) (LatLon, float64) {
	if len(l.Shape) == 0 {
		return LatLon{}, 0
	}
	if dist <= 0 {
		return l.Shape[0], bearing(l.Shape[0], l.Shape[min(1, len(l.Shape)-1)])
	}
	for i := 1; i < len(l.Shape); i++ {
		if dist <= l.shapeDist[i] {
			seg := l.shapeDist[i] - l.shapeDist[i-1]
			t := 0.0
			if seg > 0 {
				t = (dist - l.shapeDist[i-1]) / seg
			}
			a, b := l.Shape[i-1], l.Shape[i]
			return LatLon{a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])}, bearing(a, b)
		}
	}
	n := len(l.Shape)
	return l.Shape[n-1], bearing(l.Shape[max(0, n-2)], l.Shape[n-1])
}

func bearing(a, b LatLon) float64 {
	toRad := math.Pi / 180
	y := math.Sin((b[1]-a[1])*toRad) * math.Cos(b[0]*toRad)
	x := math.Cos(a[0]*toRad)*math.Sin(b[0]*toRad) - math.Sin(a[0]*toRad)*math.Cos(b[0]*toRad)*math.Cos((b[1]-a[1])*toRad)
	return math.Mod(math.Atan2(y, x)/toRad+360, 360)
}

// NetworkView est le référentiel réseau public.
type NetworkView struct {
	Operators []Operator `json:"operators"`
	Lines     []Line     `json:"lines"`
	Stops     []Stop     `json:"stops"`
}

func (p *Platform) Network() NetworkView {
	p.mu.Lock()
	defer p.mu.Unlock()
	var v NetworkView
	for _, o := range p.operators {
		v.Operators = append(v.Operators, *o)
	}
	for _, l := range p.lines {
		v.Lines = append(v.Lines, *l)
	}
	for _, s := range p.stops {
		v.Stops = append(v.Stops, *s)
	}
	sort.Slice(v.Operators, func(i, j int) bool { return v.Operators[i].ID < v.Operators[j].ID })
	sort.Slice(v.Lines, func(i, j int) bool { return v.Lines[i].ID < v.Lines[j].ID })
	sort.Slice(v.Stops, func(i, j int) bool { return v.Stops[i].ID < v.Stops[j].ID })
	return v
}

// LineByID est utilisé par le simulateur GPS.
func (p *Platform) LineByID(id string) (*Line, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	l, ok := p.lines[id]
	return l, ok
}

func (p *Platform) Vehicles() []Vehicle {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Vehicle, 0, len(p.vehicles))
	for _, v := range p.vehicles {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// NewPath prépare un tracé libre (déplacement d'un taxi dans le simulateur).
func NewPath(shape []LatLon) *Line {
	l := &Line{Shape: shape}
	l.prepare(map[string]*Stop{})
	return l
}
