using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace bitmap
{
    public partial class Form1 : Form
    {
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
        [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetCursorPos(int x, int y);
        //Mouse actions
        private const int MOUSEEVENTF_LEFTDOWN = 0x02;
        private const int MOUSEEVENTF_LEFTUP = 0x04;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x08;
        private const int MOUSEEVENTF_RIGHTUP = 0x10;
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;        // x position of upper-left corner
            public int Top;         // y position of upper-left corner
            public int Right;       // x position of lower-right corner
            public int Bottom;      // y position of lower-right corner
        }


        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string lclassName, string windowTitle);
       
        public static IntPtr HWND;
        public static Process OwnerProcess;
        public static RECT RT;
        public Rectangle MyRect = new Rectangle();
        public double MinDistance;
        public Pixel MinCoord;
        public RECT rt;
        public Bitmap bmpScreenshot;
        public List<Pixelcolor> PixelColorList = new List<Pixelcolor>();
        public List<Pixel> PixelList = new List<Pixel>();
        public Form1()
        {
            InitializeComponent();
        }

        private void button1_Click(object sender, EventArgs e)
        {
            List<Pixel> pixelList = new List<Pixel>();
   
            HWND = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null,"Legend of Mir III - Xtreme Edition");
            GetWindowRect(HWND, out rt);
            MyRect.X = rt.Left;
            MyRect.Y = rt.Top;
            MyRect.Width = rt.Right - rt.Left;
            MyRect.Height = rt.Bottom - rt.Top;
            
            
            bool Isplayed = true;
            int counter = 0;
            do
            { 
                //explore using lockbits
                MakeBitmap();
                //ThresholdUA();
                //SetCursorPos(MinCoord.X + MyRect.X, MinCoord.Y + MyRect.Y);
               // DoMouseClick(MinCoord.X + MyRect.X, MinCoord.Y + MyRect.Y);
                AttackEnemy(bmpScreenshot, pixelList);
                counter++;
                if (counter == 10)
                {
                    Isplayed = false;
                }



            } while (Isplayed == true);


        }
        public void DoMouseClick(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SetCursorPos(X, Y);
            mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)X, (uint)Y, 0, 0);
            System.Threading.Thread.Sleep(1000);
            mouse_event(MOUSEEVENTF_LEFTUP, (uint)X, (uint)Y, 0, 0);

        }
        public void MakeBitmap()
        {
            //Create a new bitmap.
            bmpScreenshot = new Bitmap(MyRect.Width,
                                          MyRect.Height);

            // Create a graphics object from the bitmap.
            var gfxScreenshot = Graphics.FromImage(bmpScreenshot);

            // Take the screenshot from the upper left corner to the right bottom corner.
            gfxScreenshot.CopyFromScreen(rt.Left,
                                        rt.Top,
                                        0,
                                        0,
                                        MyRect.Size,
                                        CopyPixelOperation.SourceCopy);

        }
        public void AttackEnemy(Bitmap bmpScreenshot, List<Pixel> pixelList)
        {
            
            pixelList.Clear();
            for (int i = 0; i < MyRect.Width; i++)
            {
                for (int j = 0; j < MyRect.Height - 1; j++)
                {
                    Color pixel = bmpScreenshot.GetPixel(i, j);
                    Color pixel1 = bmpScreenshot.GetPixel(i, j + 1);

                    if (pixel.R == pixel.G && pixel.R == pixel.B && pixel.R > 230 && pixel1.R == pixel1.G && pixel1.R == pixel1.B && pixel1.R > 230)
                    {
                        pixelList.Add(new Pixel(i, j));
                    }
                }
            }
            Pixel Character = new Pixel(MyRect.Width / 2, MyRect.Height / 2);
            MinDistance = 100000000;
            foreach (var pixel in pixelList)
            {
                double dist = Math.Sqrt(Math.Pow(Character.X - pixel.X, 2) + Math.Pow(Character.Y - pixel.Y, 2));
                if (dist < MinDistance && dist > 50)
                {
                    MinDistance = dist;
                    MinCoord = pixel;
                }
            }



            DoMouseClick(MinCoord.X + MyRect.X, MinCoord.Y + MyRect.Y);
        }
        public unsafe void ThresholdUA()
        {
            PixelList.Clear();

            BitmapData bData = bmpScreenshot.LockBits(new Rectangle(0, 0, MyRect.Width, MyRect.Height), ImageLockMode.ReadWrite, bmpScreenshot.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            for (int i = 0; i < bData.Height; ++i)
            {
                for (int j = 0; j < bData.Width; ++j)
                {
                    byte* data = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    if (data[0] == data[1] && data[0] == data[2] && data[0] > 230)
                    {
                        PixelList.Add(new Pixel(i, j));   
                    }

                    //data is a pointer to the first byte of the 3-byte color data
                    //data[0] = blueComponent;
                    //data[1] = greenComponent;
                    //data[2] = redComponent;
                    
                }
            }

            bmpScreenshot.UnlockBits(bData);
            Pixel Character = new Pixel(MyRect.Width / 2, MyRect.Height / 2);
            MinDistance = 100000000;
            foreach (var pixel in PixelList)
            {
                double dist = Math.Sqrt(Math.Pow(Character.X - pixel.X, 2) + Math.Pow(Character.Y - pixel.Y, 2));
                if (dist < MinDistance && dist > 50)
                {
                    MinDistance = dist;
                    MinCoord = pixel;
                }
            }



           


        }
    }

   
    public class Pixel
    {
        public Pixel(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int X { get; set; }
        public int Y { get; set; }
    }

    public class Pixelcolor
    {
        public Pixelcolor(byte b, byte g, byte r)
        {
            B = b;
            G = g;
            R = r;
        }

        public byte B { get; set; }
        public byte G { get; set; }
        public byte R { get; set; }
    }
}
