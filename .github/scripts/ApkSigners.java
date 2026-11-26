import com.android.apksig.ApkVerifier;
import java.io.File;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.HexFormat;

class ApkSigners {
    public static void main(String[] args) throws Exception {
        var result = new ApkVerifier.Builder(new File(args[0])).build().verify();
        if (!result.isVerified() || result.getSignerCertificates().isEmpty()) {
            throw new IllegalArgumentException("APK signature verification failed: " + result.getErrors());
        }
        var digest = MessageDigest.getInstance("SHA-256");
        for (X509Certificate signer : result.getSignerCertificates()) {
            System.out.println(HexFormat.of().formatHex(digest.digest(signer.getEncoded())));
        }
    }
}
