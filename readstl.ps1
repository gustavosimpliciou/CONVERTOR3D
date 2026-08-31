$filePath = 'C:\Users\User\Documents\Nativos 3D\Site Modelos stl\CONVERTOR3D\joker.stl'
$buf = [IO.File]::ReadAllBytes($filePath)
$size = $buf.Length
Write-Host "Tamanho: $size"
# Write first 200 bytes as hex
$hexBytes = @()
for ($i = 0; $i -lt 200 -and $i -lt $size; $i++) {
    $hexBytes += $buf[i].ToString('X2')
}
Write-Host "Primeiros 200 bytes hex: " ($hexBytes -join ' ')
# Try to interpret as ASCII for header
$header = [Text.Encoding]::ASCII.GetString($buf[0..79])
Write-Host "Header (80 bytes): $header"