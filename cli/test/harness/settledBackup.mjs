// Remove the Matrix backup loop's random startup delay so rename coverage
// includes an already-idle backup engine. Encryption randomness remains in Rust.
Math.random = () => 0;
