package pgproto3

import (
	"bytes"
	"encoding/binary"
	"reflect"
	"testing"
)

func malformedDataRow(length uint32) []byte {
	raw := []byte{0, 1, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(raw[2:], length)
	return raw
}

func TestAxiomNegativeLengthsReturnError(t *testing.T) {
	for _, n := range []uint32{0x80000000, 0xfffffffe, 0x80000001} {
		var row DataRow
		if err := row.Decode(malformedDataRow(n)); err == nil {
			t.Fatalf("negative length %x accepted", n)
		}
	}
}

func TestAxiomMalformedServerFrameReturnsError(t *testing.T) {
	raw := malformedDataRow(0xfffffffe)
	frame := append([]byte{'D', 0, 0, 0, 0}, raw...)
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(frame)-1))
	frontend := NewFrontend(NewChunkReader(bytes.NewReader(frame)), &bytes.Buffer{})
	if _, err := frontend.Receive(); err == nil {
		t.Fatal("malicious server frame accepted")
	}
}

func TestAxiomNullEmptyAndBinaryRemainDistinct(t *testing.T) {
	expected := DataRow{Values: [][]byte{nil, {}, {0, 255, 1}, []byte("hello")}}
	encoded, err := expected.Encode(nil)
	if err != nil {
		t.Fatal(err)
	}
	var row DataRow
	if err = row.Decode(encoded[5:]); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(row.Values, expected.Values) {
		t.Fatalf("valid field semantics changed: %#v", row.Values)
	}
	frontend := NewFrontend(NewChunkReader(bytes.NewReader(encoded)), &bytes.Buffer{})
	decoded, err := frontend.Receive()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded.(*DataRow).Values, expected.Values) {
		t.Fatal("valid wire result changed")
	}
}

func TestAxiomTruncationAndPositiveOverflowRefused(t *testing.T) {
	for _, raw := range [][]byte{{0}, {0, 1, 0}, malformedDataRow(0x7fffffff), malformedDataRow(1)} {
		var row DataRow
		if err := row.Decode(raw); err == nil {
			t.Fatalf("malformed row accepted: %x", raw)
		}
	}
	var row DataRow
	if err := row.Decode([]byte{0, 0}); err != nil || len(row.Values) != 0 {
		t.Fatal("zero-field row changed")
	}
}

func FuzzAxiomDataRowNeverPanics(f *testing.F) {
	for _, raw := range [][]byte{malformedDataRow(0xfffffffe), malformedDataRow(0x80000000), malformedDataRow(0xffffffff), {0, 0}, {0, 1, 0, 0, 0, 0}} {
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw []byte) { var row DataRow; _ = row.Decode(raw) })
}
